'use strict';

const K8S_NAMESPACE = 'showks';
const K8S_LABEL_SELECTOR = 'class=showks-canvas';
const REFRESH_THRESHOLD = 6000;

const got = require('got');
const express = require('express');
const app = express();
const http = require('http').Server(app);
const io = require('socket.io')(http);
const instanceNamespace = io.of('/instance');
const port = process.env.PORT || 8081;


// Kubernetes Client
const k8s = require('@kubernetes/client-node');
const k8sApiEndpoint = `/api/v1/watch/namespaces/${K8S_NAMESPACE}/services`;
const kc = new k8s.KubeConfig();
kc.loadFromCluster();
//kc.loadFromDefault();


// Instances
let instances = {};
let instanceCache = {};

function addInstance(obj) {
  let id = obj.metadata.name;
  instances[id] = getInstanceDetails(obj);
  deleteCache(id);
  instanceNamespace.emit('updated', id);
  console.log(`Added ${id}`);
}

function updateInstance(obj) {
  let id = obj.metadata.name;
  instances[id] = getInstanceDetails(obj);
  deleteCache(id);
  instanceNamespace.emit('updated', id);
  console.log(`Updated ${id}`);
}

function deleteInstance(obj) {
  let id = obj.metadata.name;
  delete instances[id];
  deleteCache(id);
  instanceNamespace.emit('deleted', id);
  console.log(`Deleted ${id}`);
}

function deleteCache(id) {
  delete instanceCache[id];
}

function getValidCache(id, path, timestamp) {
  if (instanceCache[id] === undefined) {
    console.log(`There is no cache saved for ${id}`);
    return undefined;
  }  
  let cache = instanceCache[id][path];
  if (
    cache === undefined ||
    REFRESH_THRESHOLD < (timestamp - cache.lastFetched)) {
      console.log(`Cache has been expired for ${id}, ${path}`);
      return undefined;
  }
  console.log(`Retruning cached data for ${id}, ${path}`);
  return cache;
}

function setCache(id, path, lastFetched, contentType, data) {
  if (instanceCache[id] === undefined) {
    instanceCache[id] = {};
  }
  let cache = {
    lastFetched: lastFetched,
    contentType: contentType,
    data: data
  }
  instanceCache[id][path] = cache;
  return cache;
}

function requestInstance(id, path, options) {
  let url = instances[id].url + path;
  console.log(`Requesting ${url}`);
  return got(url, options);
}


// Helper functions
function getServiceUrl(obj) {
  let host = obj.spec.clusterIP;
  let port = obj.spec.ports[0].port;
  return `http://${host}:${port}`;
}

function getCreationTimestamp(obj) {
  let date = new Date(obj.metadata.creationTimestamp);
  return date.getTime();
}

function getInstanceDetails(obj) {
  let id = obj.metadata.name;
  let instance = {
    id: id,
    url: getServiceUrl(obj),
    thumbnailUrl: `/${id}/thumbnail`,
    createdAt: getCreationTimestamp(obj)
  }
  return instance;
}

// Fetch remote data
async function fetchRemote(id, path, onlyIfCached, options) {
  // Retrieve remote data
  let cache = getValidCache(id, path, onlyIfCached ? 0 : Date.now());
  if (cache === undefined) {
    const response = await requestInstance(id, path, options);
    cache = setCache(id, path, Date.now(), response.headers['content-type'], response.body);
  }
  return cache;
}

// Generate instance array ordered by createdAt desc
async function getInstanceList() {
  let list = [];
  let keys = Object.keys(instances);
  for (let key of keys) {
    let instance = instances[key];
    try {
      let authorCache = await fetchRemote(instance.id, '/author', true, { encoding: 'utf8', json: true });
      let item = {
        id: instance.id,
//        linkUrl: instance.linkUrl,
        thumbnailUrl: instance.thumbnailUrl,
        author: authorCache.data,
        createdAt: instance.createdAt
      }
      list.push(item);
    } catch (err) {
      // simply ignore the instance
    }
  };
  list.sort((a, b) => {
    return b.createdAt - a.createdAt;
  });
  return list;
}

// Response to the HTTP client with remote data
async function responseRemote(req, res, path, onlyIfCached, options) {
  console.log(`/${req.params.id}${path} called`);
  let id = req.params.id;
  try {
    // Retrieve remote data
    let cache = await fetchRemote(id, path, onlyIfCached, options);

    // Response to the client
    res.set('Content-type', cache.contentType); 
    res.send(cache.data);
  } catch (err) {
    console.log(`an error occurred on getting instance in /${id}${path}`);
    console.log(err);
    res.status(404).send("Page not found")
  }
}


// GET /
app.use(express.static(__dirname + '/public'));

// GET /instances
app.get('/instances', async function (req, res) {
  try {
    let list = await getInstanceList();
    res.type("json");
    res.send(JSON.stringify(list));  
  } catch (err) {
    console.log(`an error occurred on getting instance list`);
    console.log(err);
    res.status(404).send("Page not found")
  }
})

/* This endpoint is for debug purpose only
// GET /instanceCache
app.get('/cache', function (req, res) {
  res.type("json");
  res.send(JSON.stringify(instanceCache));
})
*/

// GET /thumbnail
app.get('/:id/thumbnail', function (req, res) {
  responseRemote(req, res, '/thumbnail', false, { encoding: null, json: false });
})

// GET /author
app.get('/:id/author', function (req, res) {
  responseRemote(req, res, '/author', true, { encoding: 'utf8', json: true });
})

// socket.io connection handler
function onInstanceConnection(socket) {
  console.log('Connected to instance namespace.');
}

function onNotificationConnection(socket) {
  console.log('Connected to notification namespace.');
}

// Start listening socket.io
instanceNamespace.on('connection', onInstanceConnection);

// Start listening on the port for HTTP request
http.listen(port, () => console.log('listening on port ' + port));


// Get list of services
const k8sApi = kc.makeApiClient(k8s.Core_v1Api);
//  public listNamespacedService (namespace: string, pretty?: string, _continue?: string, fieldSelector?: string, includeUninitialized?: boolean, labelSelector?: string, limit?: number, resourceVersion?: string, timeoutSeconds?: number, watch?: boolean) : Promise<{ response: http.IncomingMessage; body: V1ServiceList;  }>
k8sApi.listNamespacedService(K8S_NAMESPACE, undefined, undefined, undefined, false, K8S_LABEL_SELECTOR)
.then((res) => {
  // console.log(res.body);
  try {
    let resourceVersion = res.body.metadata.resourceVersion;
    console.log(`Retrieved service list (resourceVersion: ${resourceVersion})`);
    let items = res.body.items;
    items.forEach((obj) => {
      // console.log(obj);  
      addInstance(obj);
    });
    return resourceVersion;
  } catch (err) {
    console.log('an error occurred on parsing service list');
    console.log(err);
  }
})
.then((resourceVersion) => {
  /*
  // public listNamespacedIngress (namespace: string, pretty?: string, _continue?: string, fieldSelector?: string, includeUninitialized?: boolean, labelSelector?: string, limit?: number, resourceVersion?: string, timeoutSeconds?: number, watch?: boolean) : Promise<{ response: http.IncomingMessage; body: V1beta1IngressList;  }>
  k8sApi.listNamespacedIngress(K8S_NAMESPACE, undefined, undefined, undefined, false, K8S_LABEL_SELECTOR)
  .then((res) => {
    console.log(res.body);
    try {
      let resourceVersion = res.body.metadata.resourceVersion;
      console.log(`Retrieved service list (resourceVersion: ${resourceVersion})`);
      let items = res.body.items;
      items.forEach((obj) => {
        // console.log(obj);  
        addInstance(obj);
      });
      return resourceVersion;
    } catch (err) {
      console.log('an error occurred on parsing service list');
      console.log(err);
    }
  })*/  

  // Start watching Kubernetes cluster
  console.log(`Start watching Kubernetes cluster from resourceVersion: ${resourceVersion}`);
  let watch = new k8s.Watch(kc);
  let req = watch.watch(
    k8sApiEndpoint,
    {
      labelSelector: K8S_LABEL_SELECTOR,
      resourceVersion: resourceVersion
    },
    (type, obj) => {
      // console.log(obj);  
      try {
        if (type == 'ADDED') {
          console.log('new instance was added');
          addInstance(obj);

        } else if (type == 'MODIFIED') {
          console.log('an instance was modified');
          updateInstance(obj);

        } else if (type == 'DELETED') {
          console.log('an instance has beed deleted');
          deleteInstance(obj);

        } else {
          console.log('unknown type: ' + type);

        }
      } catch (err) {
        console.log('an error occurred on parsing service object');
        console.log(err);
      }
    },
    // done callback is called if the watch terminates normally
    (error) => {
        if (error) {
          console.log('an error occurred in the watch callback');
          console.log(error);
        }
    });
});
