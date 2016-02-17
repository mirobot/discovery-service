#!/usr/bin/env node
//  OpenShift sample Node application
var express = require('express');
var fs      = require('fs');
var ejs = require('ejs');
var r = require("redis");


var redis_conf = {
  host: (process.env.OPENSHIFT_REDIS_HOST || 'localhost'),
  port: (process.env.OPENSHIFT_REDIS_PORT || 6379),
  password: process.env.REDIS_PASSWORD
}
var redis = r.createClient(redis_conf);
if(redis_conf.password) redis.auth(redis_conf.password);

redis.on("error", function (err) {
  console.log("" + err);
});

/**
 *  Define the sample application.
 */
var DiscoveryApp = function() {

  //  Scope.
  var self = this;


  /*  ================================================================  */
  /*  Helper functions.                                                 */
  /*  ================================================================  */

  /**
   *  Set up server IP address and port # using env variables/defaults.
   */
  self.setupVariables = function() {
    //  Set the environment variables we need.
    self.ipaddress = process.env.OPENSHIFT_NODEJS_IP;
    self.port      = process.env.OPENSHIFT_NODEJS_PORT || 8080;

    if (typeof self.ipaddress === "undefined") {
      //  Log errors on OpenShift but continue w/ 127.0.0.1 - this
      //  allows us to run/test the app locally.
      console.warn('No OPENSHIFT_NODEJS_IP var, using 127.0.0.1');
      self.ipaddress = "127.0.0.1";
    };
  };


  /**
   *  Populate the cache.
   */
  self.populateCache = function() {
    //  Local cache for static content.
    self.indexPage = fs.readFileSync('./index.html').toString('utf8');
  };


  /**
   *  terminator === the termination handler
   *  Terminate server on receipt of the specified signal.
   *  @param {string} sig  Signal to terminate on.
   */
  self.terminator = function(sig){
    if (typeof sig === "string") {
      console.log('%s: Received %s - terminating sample app ...', Date(Date.now()), sig);
      process.exit(1);
    }
    console.log('%s: Node server stopped.', Date(Date.now()) );
  };


  /**
   *  Setup termination handlers (for exit and a list of signals).
   */
  self.setupTerminationHandlers = function(){
    //  Process on exit and signals.
    process.on('exit', function() { self.terminator(); });

    // Removed 'SIGPIPE' from the list - bugz 852598.
    ['SIGHUP', 'SIGINT', 'SIGQUIT', 'SIGILL', 'SIGTRAP', 'SIGABRT',
     'SIGBUS', 'SIGFPE', 'SIGUSR1', 'SIGSEGV', 'SIGUSR2', 'SIGTERM'
    ].forEach(function(element, index, array) {
        process.on(element, function() { self.terminator(element); });
    });
  };


  /*  ================================================================  */
  /*  App server functions (main app logic here).                       */
  /*  ================================================================  */
  
  self.addAddress = function(req, res){
    // store IP address and name in redis under the address key
    redis.zadd(req.ip, Date.now(), req.query.name + '|' + req.query.address, function(err, reply){
      if(err){
        res.send(500);
      }else{
        res.send(204);
      }
    });
  }
  
  function parseSet(data){
    var out = [];
    for(var i = 0; i< data.length; i+= 2){
      out.push({
        key: data[i],
        name: data[i].split('|')[0],
        address: data[i].split('|')[1],
        last_seen: Number(data[i+1])
      });
    }
    return out;
  }
  
  function getData(key, cb){
    redis.zrange(key, 0, -1, 'withscores', function(err, resp) {
      if(err) return cb(err);
      var data = parseSet(resp);
      var m = redis.multi();
      // Filter out devices older than 60 minutes
      var cutoff = Date.now() - (1000 * 60 * 60);
      for(var i = data.length - 1; i >= 0; i--){
        if(data[i].last_seen < cutoff){
          m.zrem(key, data[i].key);
          data.splice(i, 1);
        }
      };
      
      // Filter out devices with the same name in case it's just changed IP address
      var valid = {};
      for(var i = data.length - 1; i >= 0; i--){
        if(valid[data[i].name]){
          if(valid[data[i].name].last_seen < data[i].last_seen){
            //delete the other record
            data.splice(valid[data[i].name].id, 1);
            m.zrem(key, valid[data[i].name].key);
            //and put in the new one
            valid[data[i].name] = data[i];
            valid[data[i].name].id = i;
          }else{
            //delete this record
            m.zrem(key, data[i].key);
            data.splice(i, 1);
          }
        }else{
          valid[data[i].name] = data[i];
        }
      };
      
      m.exec(function(err, replies){
        data.map(function(el){
          delete el.key;
          delete el.id;
        })
        cb(err, data);
      });
    });
  }
  
  self.discover = function(req, res, format){
    // Fetch all devices on this network
    getData(req.ip, function(err, data){
      if(err){
        res.send(500);
      }else{
        if(format === 'html'){
          res.setHeader('Content-Type', 'text/html');
          res.send(ejs.render(self.indexPage, {devices: data}));
        }else if(format === 'json'){
          res.setHeader('Content-Type', 'application/json');
          res.send(JSON.stringify({devices: data}));
        }
      }
    });
  }

  /**
   *  Initialize the server (express) and create the routes and register
   *  the handlers.
   */
  self.initializeServer = function() {
    self.app = express();

    self.app.set('trust proxy', true);

    //  Add handlers for the app (from the routes).
    self.app.post('/', function(req, res){ self.addAddress(req, res)});
    self.app.get('/', function(req, res){ self.discover(req, res, 'html')});
    self.app.get('/devices.json', function(req, res){ self.discover(req, res, 'json')});
  };


  /**
   *  Initializes the sample application.
   */
  self.initialize = function() {
    self.setupVariables();
    self.populateCache();
    self.setupTerminationHandlers();

    // Create the express server and routes.
    self.initializeServer();
  };


  /**
   *  Start the server (starts up the sample application).
   */
  self.start = function() {
    //  Start the app on the specific interface (and port).
    self.app.listen(self.port, self.ipaddress, function() {
      console.log('%s: Node server started on %s:%d ...', Date(Date.now() ), self.ipaddress, self.port);
    });
  };

};

// Start the app
var app = new DiscoveryApp();
app.initialize();
app.start();

