import { Service, ServiceMessage, ServiceOptions } from "graphscript-core";
import Worker from 'web-worker' //cross platform for node and browser
import { Graph, GraphNode, GraphNodeProperties } from "graphscript-core";

declare var WorkerGlobalScope;

export type WorkerRoute = {
    worker?:WorkerInfo
    workerUrl?: string|URL|Blob,
    transferFunctions?:{[key:string]:Function},
    transferClasses?:{[key:string]:Function},
    parentRoute?:string, //if a child of a worker node, subscribe to a route on a parent worker?
    portId?:string, //port to subscribe to for the parent route? will establish new one if parent has a worker defined, there is no limit on MessagePorts so they can be useful for organizing 
    callback?:string, //Run this route on the worker when the operator is called. If this route is a child of another node, run this node on the child worker when it receives a message. 
    stopped?:boolean, // Don't run the callback until we call the thread to start? E.g. for recording data periodically.
    blocking?:boolean, //should the subscribed worker wait for the subscriber to resolve before sending a new result? Prevents backup and makes async processing easier
    init?:string, //run a callback on the worker on worker init?
    initArgs?:any[] //arguments to go with the worker init?
    initTransfer?:any[] //transferrable stuff with the init?
} & GraphNodeProperties & WorkerProps

export type WorkerProps = {
    worker?:WorkerInfo,
    workerUrl?: string|URL|Blob,
    url?:URL|string|Blob,
    _id?:string,
    port?:MessagePort, //message channel for this instance
    onmessage?:(ev)=>void,
    onerror?:(ev)=>void,
    onclose?:(worker:Worker|MessagePort)=>void
} 

export type WorkerInfo = {
    worker:Worker|MessagePort,
    send:(message:any,transfer?:any)=>void,
    request:(message:any, method?:string,transfer?:any)=>Promise<any>,
    post:(route:any, args?:any, method?:string, transfer?:any)=>void,
    run:(route:any, args?:any, method?:string,transfer?:any)=>Promise<any>
    subscribe:(route:any, callback?:((res:any)=>void)|string, args?:any[], key?:string, subInput?:boolean, blocking?:boolean)=>Promise<any>,
    unsubscribe:(route:any, sub:number)=>Promise<boolean>,
    start:(route?:any, portId?:string, callback?:((res:any)=>void)|string, blocking?:boolean)=>Promise<boolean>,
    stop:(route?:string, portId?:string)=>Promise<boolean>,
    workerSubs:{[key:string]:{sub:number|false, route:string, portId:string, callback?:((res:any)=>void)|string, blocking?:boolean}},
    terminate:()=>boolean,
    postMessage:(message:any,transfer?:any[])=>void, //original worker post message
    graph:WorkerService,
    _id:string
} & WorkerProps & WorkerRoute

//this spawns the workers
export class WorkerService extends Service {
    
    name='worker'
    
    workers:{
        [key:string]:WorkerInfo
    }={}

    threadRot = 0; //thread rotation if not specifying

    connections: any;

    constructor(options?:ServiceOptions) {
        super();

        this.connections = { //higher level reference for Router
            workers:this.workers
        }
    
        if(options?.services) this.addServices(options.services);
        this.load(this);
        this.setLoaders(this.workerloader); //add a custom route loader for the worker logic
        if(options) this.init(options);

        if(typeof WorkerGlobalScope !== 'undefined' && globalThis instanceof WorkerGlobalScope) {
            this.addDefaultMessageListener();    
        }
    }

    loadWorkerRoute = (node:WorkerRoute & GraphNode, routeKey:string) => {
        if(node.workerUrl) node.url = node.workerUrl;
        if(node._id) node.__node.tag = node._id;
        if(!node.__node.tag) node.__node.tag = routeKey;
        node._id = node.__node.tag;

        let worker:WorkerInfo;
        if(this.workers[node._id]) worker = this.workers[node._id];
        else if (node.worker) worker = node.worker;
        if(!worker) {
            worker = this.addWorker(node);
        }

        node.worker = worker;

        if(!node.__ondisconnected) {
            let ondelete = (rt) => { //removing the original route will trigger ondelete
                rt.worker?.terminate();
            }
            node.__addOndisconnected(ondelete);
        }
        //console.log(rt);

        //requires remoteGraphRoutes on the worker (enabled on the default worker)
        if(node.transferFunctions) {
            for(const prop in node.transferFunctions) {
                this.transferFunction(worker,node.transferFunctions[prop],prop)
            }
        }
        if(node.transferClasses) {
            for(const prop in node.transferClasses) {
                this.transferClass(worker,node.transferClasses[prop],prop)
            }
        }

        if(worker) {
            if(!node.__operator) {
                node.__operator = (...args) => {
                    //console.log('operator', args)
                    if(node.callback) {
                        if(!this.__node.nodes.get(node.__node.tag)?.__children) worker.post(node.callback,args);
                        else return worker.run(node.callback,args);
                    } else {
                        if(!this.__node.nodes.get(node.__node.tag)?.__children) worker.send(args);
                        else return worker.request(args);
                    }
                }
            }

            if(node.init) { //requires remoteGraphRoutes
                worker.run(node.init,node.initArgs,undefined,node.initTransfer);
            } 

            // //need remoteGraphRoutes loaded
            // worker.run('setValue',[rt.callback+'_routeProxy', rt.callback]);

            // this.transferFunction(
            //     worker,
            //     function routeProxy(data:any) {
            //         let r = this.graph.nodes.get(this.graph[this.tag]).__operator(data);
                    
            //         if(this.graph.state.triggers[this.graph[this.tag]]) {
            //             if(r instanceof Promise) {
            //                 r.then((rr) => {
            //                     if(rr !== undefined) this.setState({[this.graph[this.tag]]:rr});
            //                 });
            //             }
            //             else if(r !== undefined) this.setState({[this.graph[this.tag]]:r}); //so we can subscribe to the original route
            //         }

            //         return r;
            //     },
            //     rt.callback+'_routeProxy'
            // )

            // rt.callback = rt.callback+'_routeProxy'; //proxying through here 

            return worker;
        }
    }

    workerloader:any = { //todo: clean this up and extrapolate to other services
        'workers':(node: WorkerRoute & GraphNode, parent:WorkerRoute & GraphNode, graph:Graph, roots:any) => {
            let rt = node as WorkerRoute;
            if(!node.parentRoute && (parent?.callback && parent?.worker)) node.parentRoute = parent?.callback;
            if(rt?.worker || (rt?._id && this.workers[rt._id]) || (rt as WorkerRoute)?.workerUrl) { //each set of props with a worker will instantiate a new worker, else you can use the same worker elsewhere by passing the corresponding tag

                let worker = this.loadWorkerRoute(rt as any, rt.__node.tag);
                
                if(worker) {
                    if(!rt.parentRoute && (rt.__parent as any)?.callback) rt.parentRoute = (rt.__parent as any).callback;
                    if(rt.__parent && !rt.portId){ 
                        if(typeof rt.__parent === 'string') {
                            if(rt.__node.tag !== rt.__parent && worker._id !== rt.__parent)
                                rt.portId = this.establishMessageChannel(worker, rt.__parent) as string; 
                        }
                        else if(rt.__node.tag !== rt.__parent?.__node?.tag && worker._id !== rt.__parent?.tag) {
                            rt.portId = this.establishMessageChannel(worker, (rt.__parent as any).worker) as string; 
                        }
                    };
                    if(rt.parentRoute) {
                        if(!rt.stopped) {
                            if(typeof rt.__parent === 'string' && rt.__parent === worker._id) {
                                worker.run('subscribe', [rt.parentRoute, undefined, undefined, rt.callback]);
                            }
                            else if(rt.__node.tag === rt.__parent?.__node?.tag || worker._id === rt.__parent?.__node?.tag) {
                                worker.run('subscribe', [rt.parentRoute, undefined, undefined, rt.callback]);
                            }
                            else worker.run('subscribeToWorker', [rt.parentRoute, rt.portId, undefined, rt.callback, undefined, undefined, rt.blocking]).then((sub)=>{ //if no callback specified it will simply setState on the receiving thread according to the portId
                                worker.workerSubs[rt.parentRoute+rt.portId].sub = sub;
                            });
                        }
                        if(!(typeof rt.__parent === 'string' && rt.__parent === worker._id) && !(rt.__node.tag === rt.__parent?.__node?.tag || worker._id === rt.__parent?.__node?.tag)) 
                            worker.workerSubs[rt.parentRoute+rt.portId] = {sub:null, route:rt.parentRoute, portId:rt.portId, callback:rt.callback, blocking:rt.blocking };
                    } else if (rt.__parent) {
                        if(typeof rt.__parent === 'string') {
                            if(!rt.stopped) {
                                if(rt.__parent === worker._id) {
                                    worker.run('subscribe', [rt.__parent, undefined, rt.callback]);
                                }
                                else  worker.run('subscribeToWorker', [rt.__parent, rt.portId, undefined, rt.callback, undefined, undefined, rt.blocking]).then((sub)=>{ //if no callback specified it will simply setState on the receiving thread according to the portId
                                    worker.workerSubs[rt.__parent+rt.portId].sub = sub;
                                });
                            }
                            if(!(typeof rt.__parent === 'string' && rt.__parent === worker._id)) 
                                worker.workerSubs[rt.__parent+rt.portId] = {sub:null, route:worker._id, portId:rt.portId, callback:rt.callback, blocking:rt.blocking };
                           
                        } else if(rt.__parent?.__node?.tag && rt.__parent?.worker) {
                            //console.log(rt);
                            if(!rt.stopped) {
                                if(rt.__node.tag === rt.__parent.__node.tag || worker._id === rt.__parent.__node.tag) {
                                    worker.run('subscribe', [rt.__parent.__node.tag, undefined, undefined, rt.callback]);
                                }
                                else worker.run('subscribeToWorker', [rt.__parent.__node.tag, rt.portId, undefined, rt.callback, undefined, undefined, rt.blocking]).then((sub)=>{ //if no callback specified it will simply setState on the receiving thread according to the portId
                                    worker.workerSubs[rt.__parent.__node.tag+rt.portId].sub = sub;
                                });
                            }
                            if(!(rt.__node.tag === rt.__parent?.__node?.tag || worker._id === rt.__parent?.__node?.tag)) 
                                worker.workerSubs[rt.__parent.__node.tag+rt.portId] = {sub:null, route:rt.__parent.__node.tag, portId:rt.portId, callback:rt.callback, blocking:rt.blocking };
                        }
                    }

                }
            } else if(rt.__parent && rt.parentRoute) {
                if(typeof rt.__parent === 'string' && (roots[rt.__parent] as any)?.worker) {
                    ((roots[rt.__parent] as any).worker as WorkerInfo).subscribe(rt.parentRoute, rt.__operator, undefined, undefined, undefined, rt.blocking);
                } else if((rt.__parent as any)?.worker) {
                    ((rt.__parent as any).worker as WorkerInfo).subscribe(rt.parentRoute, rt.__operator, undefined, undefined, undefined, rt.blocking);
                }
            }
            //console.log(rt);
            return rt;
        }
    }

    //works in window as well (caution)
    addDefaultMessageListener = () => {
        globalThis.onmessage = (ev:MessageEvent) => {
            let result = this.receive(ev.data); //this will handle graph logic and can run requests for the window or messsage ports etc etc.
            //console.log(JSON.stringify(ev.data), JSON.stringify(result),JSON.stringify(Array.from((self as any).SERVICE.nodes.keys())))
            //console.log(result);

            if(this.__node.keepState) this.setState({[this.name]:result}); //subscribe to all outputs
        } //this will work for iframes too
    }

    //post messages to workers or to window (or self as worker)
    postMessage = (message:any, target:string, transfer?:Transferable[]) => {
        if(this.workers[target]) {
            this.workers[target].send(message,transfer);
        } else {
            globalThis.postMessage(message, target, transfer)
        }
    }

    addWorker = (options:{
        url?:URL|string|Blob,
        port?:MessagePort,
        _id?:string,
        onmessage?:(ev)=>void,
        onerror?:(ev)=>void
    }) => { //pass file location, web url, or javascript dataurl string
        let worker:Worker|MessagePort;

        if(!options._id) 
            options._id = `worker${Math.floor(Math.random()*1000000000000000)}`;

        if(options.url) worker = new Worker(options.url);
        else if (options.port) {
            worker = options.port;
        } else if (this.workers[options._id]) {
            if(this.workers[options._id].port) worker = this.workers[options._id].port;
            else worker = this.workers[options._id].worker;
        }

        //console.log('adding worker', options._id);

        if(!worker) return;

        let send = (message:any,transfer?:any) => {
            //console.log('sent', message)
            return this.transmit(message,worker,transfer);
        }

        let post = (route:any,args?:any,method?:string, transfer?:any) => {
            //console.log('sent', message)
            let message:any = {
                route,
                args
            };
            if(method) message.method = method;
            //console.log(message);
            return this.transmit(message,worker,transfer);
        }

        let run = (route:any, args?:any, method?:string, transfer?:any) => {
            return new Promise ((res,rej) => {
                let callbackId = Math.random();
                let req = {route:'runRequest', args:[{route, args}, options._id, callbackId]} as any;
                //console.log(req)
                if(method) req.args[0].method = method;
                let onmessage = (ev)=>{
                    if(typeof ev.data === 'object') {
                        if(ev.data.callbackId === callbackId) {
                            worker.removeEventListener('message',onmessage);
                            res(ev.data.args); //resolve the request with the corresponding message
                        }
                    }
                }
                worker.addEventListener('message',onmessage);
                
                this.transmit(req, worker, transfer);
            });
        }
        
        let request = (message:ServiceMessage|any, method?:string, transfer?:any) => {
            return new Promise ((res,rej) => {
                let callbackId = Math.random();
                let req = {route:'runRequest', args:[message,options._id,callbackId]} as any;
                //console.log(req)
                if(method) req.method = method;
                let onmessage = (ev)=>{
                    if(typeof ev.data === 'object') {
                        if(ev.data.callbackId === callbackId) {
                            worker.removeEventListener('message',onmessage);
                            res(ev.data.args); //resolve the request with the corresponding message
                        }
                    }
                }
                worker.addEventListener('message',onmessage)
                this.transmit(req, worker, transfer);
            });
        }

        let workerSubs = {};

        //subscribe to this worker from the thread running this function
        let subscribe = (route:any, callback?:((res:any)=>void)|string,  args?:any[], key?:string, subInput?:boolean, blocking?:boolean) => {
            return this.subscribeToWorker(route, options._id, callback, args, key, subInput, blocking);
        }

        let unsubscribe = (route:any, sub:number):Promise<any> => {
            return run('unsubscribe',[route,sub]);
        }

        //start a subscription to another worker/main thread on this worker
        let start = async (route?:string, portId?:string, callback?:string, blocking?:boolean) => {
            if(route)
                await run('subscribeToWorker',[route, portId, undefined, callback, blocking]).then((sub) => { 
                    if(sub) workerSubs[route+portId] = {sub, route, portId, callback, blocking}; 
                });
            else for(const key in workerSubs) {
                if(typeof workerSubs[key].sub !== 'number') 
                    await run('subscribeToWorker', [workerSubs[key].route, workerSubs[key].portId, undefined, workerSubs[key].callback, undefined, workerSubs[key].blocking]).then((sub) => {
                        workerSubs[key].sub = sub;
                    }); 

                console.log(JSON.stringify(workerSubs));
            }
            return true;
        }

        //stop a subscription to another worker/main thread on this worker
        let stop = async (route?:string, portId?:string) => {
            if(route && portId && workerSubs[route+portId]) {
                await run('unsubscribe',[route,workerSubs[route+portId].sub]);
                workerSubs[route+portId].sub = false;
            } else {
                for(const key in workerSubs) {
                    if(typeof workerSubs[key].sub === 'number') {
                        await run('unpipeWorkers', [workerSubs[key].route, workerSubs[key].portId, workerSubs[key].sub]).then(console.log);
                    } workerSubs[key].sub = false;
                    
                }
            }
            return true;
        }

        let terminate = () => {
            for(const key in workerSubs) {
                if(typeof workerSubs[key].sub === 'number') {
                    run('unpipeWorkers', [workerSubs[key].route, workerSubs[key].portId, workerSubs[key].sub]);
                } workerSubs[key].sub = false;
            }
            return this.terminate(options._id);
        }

        if(!options.onmessage) options.onmessage = (ev) => {
            this.receive(ev.data);
            this.setState({[options._id as string]:ev.data});
        }

        if(!options.onerror) {
            options.onerror = (ev) => {
                console.error(ev.data);
            }
        }

        worker.onmessage = options.onmessage;
        (worker as Worker).onerror = options.onerror;
        

        let workersettings = {
            worker:(worker as any),
            __node:{tag:options._id},
            send,
            post,
            run,
            request,
            subscribe,
            unsubscribe,
            terminate,
            start,
            stop,
            postMessage:worker.postMessage,
            workerSubs,
            graph:this,
            ...options
        } as WorkerInfo;

        let node = this.add(workersettings);

        this.workers[options._id] = node as GraphNode & WorkerInfo;

        node.__addOndisconnected(function() { terminate(); });

        return this.workers[options._id];
    }

    open = this.addWorker; //for the router

    close = () => {
        globalThis.close(); //workers can terminate themselves
    }

    //new Worker(urlFromString)
    // toObjectURL = (scriptTemplate:string) => {
    //     let blob = new Blob([scriptTemplate],{type:'text/javascript'});
    //     return URL.createObjectURL(blob);
    // }

    getTransferable(message:any) {
        //automatic dataview/typedarray/arraybuffer transferring. 
        // There are more transferable types but we start to slow things 
        //   down if we check too many cases so make transfer explicit in general! This is mainly for automating subscriptions
        let transfer;
        if(typeof message === 'object') {
            if(message.args) {
                if (message.args?.constructor?.name === 'Object') {
                    for(const key in message.args) {
                        if(ArrayBuffer.isView(message.args[key])) {
                            if(!transfer) 
                                transfer = [message.args[key].buffer]  as StructuredSerializeOptions;
                            else 
                                (transfer as any[]).push(message.args[key].buffer);
                        } else if (message.args[key]?.constructor?.name === 'ArrayBuffer') {
                            if(!transfer) 
                                transfer = [message.args[key]]  as StructuredSerializeOptions;
                            else 
                                (transfer as any[]).push(message.args[key]);
                        }
                    }
                }
                else if(Array.isArray(message.args) && message.args.length < 11) { //lets check any argument less size 10 or less for typed array inputs
                    message.args.forEach((arg) => {
                        if(ArrayBuffer.isView(arg)) { 
                            transfer = [arg.buffer] as StructuredSerializeOptions;
                        } else if (arg?.constructor?.name === 'ArrayBuffer') 
                            transfer = [arg] as StructuredSerializeOptions;
                    });
                } 
                else if(ArrayBuffer.isView(message.args)) { 
                    transfer = [message.args.buffer] as StructuredSerializeOptions;
                } 
                else if (message.args?.constructor?.name === 'ArrayBuffer') {
                    transfer = [message] as StructuredSerializeOptions;
                } 
            }
            else if (message?.constructor?.name === 'Object') { 
                for(const key in message) {
                    if(ArrayBuffer.isView(message[key])) {
                        if(!transfer) 
                            transfer = [message[key].buffer]  as StructuredSerializeOptions;
                        else 
                            (transfer as any[]).push(message[key].buffer);
                    } else if (message[key]?.constructor?.name === 'ArrayBuffer') {
                        if(!transfer) 
                            transfer = [message[key]]  as StructuredSerializeOptions;
                        else 
                            (transfer as any[]).push(message[key]);
                    }
                }
            }
            else if(Array.isArray(message) && message.length < 11) { //lets check any argument size 10 or less for typed array inputs
                message.forEach((arg) => {
                    if(ArrayBuffer.isView(arg)) { 
                        transfer = [arg.buffer] as StructuredSerializeOptions;
                    } else if (arg.constructor?.name === 'ArrayBuffer') 
                        transfer = [arg] as StructuredSerializeOptions;
                });
            } 
            else if(ArrayBuffer.isView(message)) { 
                transfer = [message.buffer] as StructuredSerializeOptions;
            }  
            else if (message.constructor?.name === 'ArrayBuffer') {
                transfer = [message] as StructuredSerializeOptions;
            } 
        }

        return transfer;
    }

    transmit = (message:ServiceMessage|any, worker?:Worker|MessagePort|string, transfer?:StructuredSerializeOptions ) => {
        
        if(!transfer) {
            transfer = this.getTransferable(message); //automatically transfer arraybuffers
        }

        if(worker instanceof Worker || worker instanceof MessagePort) {
            worker.postMessage(message,transfer);
        } else if(typeof worker === 'string') {
            if(this.workers[worker as string]) {
                if(this.workers[worker as string].port)
                    (this.workers[worker as string].port as any).postMessage(message,transfer);
                else if (this.workers[worker as string].worker) 
                    this.workers[worker as string].worker.postMessage(message,transfer);
            }
        } else {
            let keys = Object.keys(this.workers);
            this.workers[keys[this.threadRot]].worker.postMessage(message,transfer);
            this.threadRot++;
            if(this.threadRot === keys.length) this.threadRot = 0;
        }
        return message;
    }

    terminate = (worker:Worker|MessagePort|string|WorkerInfo) => {
        let onclose;
        
        let str;
        if(typeof worker === 'string') {
            str = worker;
            let obj = this.workers[worker];
            if(obj) {
                delete this.workers[worker];
                worker = obj.worker;
                if(obj.onclose) onclose = obj.onclose;
            }
        } else if (typeof worker === 'object') {
            if((worker as WorkerInfo)?._id) {
                worker = (worker as WorkerInfo).worker;
                delete this.workers[(worker as WorkerInfo)?._id];
            }
        }
        if(worker instanceof Worker) {
            worker.terminate();
            if(onclose) onclose(worker);
            if(str && this.get(str)) this.remove(str);
            return true;
        }
        if(worker instanceof MessagePort) {
            worker.close();
            if(onclose) onclose(worker);
            if(str && this.get(str)) this.remove(str);
            return true;
        }
        return false;
    }

    //if no second id provided, message channel will exist to this thread
    establishMessageChannel = (
        worker:Worker|string|MessagePort|WorkerInfo, 
        worker2?:Worker|string|MessagePort|WorkerInfo
    ) => {
        
        let workerId;
        if(typeof worker === 'string') {
            workerId = worker;
            if(this.workers[worker]){
                if(this.workers[worker].port) worker = this.workers[worker].port;
                else worker2 = this.workers[worker].worker;
            }
        } else if ((worker as WorkerInfo)?.worker) {
            worker = (worker as WorkerInfo).worker
        }
        if(typeof worker2 === 'string') {
            if(this.workers[worker2]){
                if(this.workers[worker2].port) worker2 = this.workers[worker2].port;
                else worker2 = this.workers[worker2].worker;
            }
        } else if ((worker2 as WorkerInfo)?.worker) {
            worker2 = (worker2 as WorkerInfo).worker
        }

        if(worker instanceof Worker || worker instanceof MessagePort) {
            let channel = new MessageChannel();
            let portId = `port${Math.floor(Math.random()*1000000000000000)}`;

            worker.postMessage({route:'addWorker',args:{port:channel.port1, _id:portId }},[channel.port1]);

            if(worker2 instanceof Worker || worker2 instanceof MessagePort) {
                worker2.postMessage({route:'addWorker',args:{port:channel.port2, _id:portId }},[channel.port2]);
            } else if(workerId && this.workers[workerId]) {
                channel.port2.onmessage = this.workers[workerId].onmessage;
                this.workers[workerId].port = channel.port2;
            }
        
            return portId;
        }

        return false;
        
    }

    request = (message:ServiceMessage|any, workerId:string, transfer?:any, method?:string) => {
        let worker = this.workers[workerId].worker;
        return new Promise ((res,rej) => {
            let callbackId = Math.random();
            let req = {route:'runRequest', args:[message, callbackId]} as any;
            if(method) req.method = method;
            let onmessage = (ev)=>{
                if(typeof ev.data === 'object') {
                    if(ev.data.callbackId === callbackId) {
                        worker.removeEventListener('message',onmessage);
                        res(ev.data.args); //resolve the request with the corresponding message
                    }
                }
            }
            worker.addEventListener('message',onmessage)
            this.transmit(req, worker, transfer);
        });
    }

    runRequest = (message:ServiceMessage|any, worker:undefined|string|Worker|MessagePort, callbackId:string|number, getTransferable=true) => {

        let res = this.receive(message);

        if(typeof worker === 'string' && this.workers[worker]) {
            if(this.workers[worker].port) worker = this.workers[worker].port;
            else worker = this.workers[worker].worker;
        }
        if(res instanceof Promise) {
            res.then((r) => {
                let transfer = getTransferable ? this.getTransferable(r) : undefined;
                if(worker instanceof Worker || worker instanceof MessagePort) 
                    worker.postMessage({args:r,callbackId}, transfer)
                else if(typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope)
                    globalThis.postMessage({args:r,callbackId},transfer);
            });
        } else {
            let transfer = getTransferable ? this.getTransferable(res) : undefined;
            if(worker instanceof Worker || worker instanceof MessagePort) 
                worker.postMessage({args:res,callbackId}, transfer)
            else if(typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope)
                globalThis.postMessage({args:res,callbackId}, transfer);
        }

        return res;
    }

    subscribeWorker = (
        route:string, 
        worker:WorkerInfo|Worker|string|MessagePort, 
        args?:any[],
        key?:string,
        subInput?:boolean,
        blocking?:boolean, //requires a WorkerInfo object 
        getTransferable:boolean=true
    ) => {
        if(this.restrict?.[route]) return undefined;

        let callback:(res:any) => void;

        //console.log('subscribeWorker', route, worker, blocking);

        if(blocking) {

            let blocked = false;

            callback = (res:any) => {
                //console.log(worker,res,route,blocked)
                if(!blocked) {
                    blocked = true;
                
                    if(res instanceof Promise) {
                        res.then((r) => {
                            if((worker as WorkerInfo)?.run) 
                                (worker as WorkerInfo).run('triggerSubscription',[route,(worker as WorkerInfo)._id,r]).then((ret)=>{
                                    blocked = false;
                                    //if(ret !== undefined) this.setState({[worker._id]:ret});
                                    //console.log(ret)
                                });
                        });
                    } else {
                        if((worker as WorkerInfo)?.run) 
                            (worker as WorkerInfo).run('triggerSubscription',[route,(worker as WorkerInfo)._id,res]).then((ret)=>{
                                blocked = false;
                                //if(ret !== undefined) this.setState({[worker._id]:ret});
                                //console.log(ret)
                            });
                    }
                } 
            }
        }
        else {
            callback = (res:any) => {
                //console.log('subscription triggered for', route, 'to', worker instanceof Worker ? worker : 'window', 'result:', res);
                if(res instanceof Promise) {
                    res.then((r) => {
                        let transfer = getTransferable ? this.getTransferable(r) : undefined;
                        //console.log(transfer);
                        if((worker as Worker)?.postMessage) 
                            (worker as Worker).postMessage({args:r,callbackId:route}, transfer)
                        else if(globalThis.postMessage)
                            globalThis.postMessage({args:r,callbackId:route}, transfer);
                    });
                } else {
                    let transfer = getTransferable ? this.getTransferable(res) : undefined;
                    //console.log(transfer);
                    if((worker as Worker)?.postMessage) 
                        (worker as Worker).postMessage({args:res,callbackId:route}, transfer)
                    else if(globalThis.postMessage)
                        globalThis.postMessage({args:res,callbackId:route}, transfer);
                }
            }
        }

        if(!blocking && (worker as WorkerInfo)?.port) {
            worker = (worker as WorkerInfo).port;
        }
        else if(!blocking && (worker as WorkerInfo)?.worker) {
            worker = (worker as WorkerInfo).worker;
        } 
        else if(typeof worker === 'string' && this.workers[worker]) {
            if(blocking) worker = this.workers[worker];
            else if(this.workers[worker].port) worker = this.workers[worker].port;
            else worker = this.workers[worker].worker;
        } //else we are subscribing to window

        return this.subscribe(route, callback, args, key, subInput);
    }

    subscribeToWorker = (
        route:string, 
        workerId:string, 
        callback?:((res:any)=>void)|string,
        args?:any[],
        key?:string,
        subInput?:boolean,
        blocking?:boolean, //blocking subscriptions won't return if the subscribing thread hasn't finished with the result
        getTransferable = true //auto process transfer arrays (default true)
    ) => {

        if(typeof workerId === 'string' && this.workers[workerId]) {
            this.__node.state.subscribeEvent(workerId, (res) => {
                if(res?.callbackId === route) {
                    if(!callback) this.setState({[workerId]:res.args}); //just set state
                    else if(typeof callback === 'string') { //run a local node
                        this.run(callback,res.args);
                    }
                    else callback(res.args);
                }
            });
            return this.workers[workerId].run('subscribeWorker', [route, workerId, args, key, subInput, blocking, getTransferable]);
        }
    }

    triggerSubscription = async (
        route:string,
        workerId:string,
        result:any
    ) => {
        if(this.__node.state.triggers[workerId]) for(let i = 0; i < this.__node.state.triggers[workerId].length; i++) {
            await this.__node.state.triggers[workerId][i].onchange({args:result, callbackId:route});//make sure async stuff resolves too
        }
        return true;
    }

    pipeWorkers = ( //worker a listens to worker b, be sure to unsubscribe on the source when terminating
        sourceWorker:WorkerInfo|string,
        listenerWorker:WorkerInfo|string, 
        sourceRoute:string, 
        listenerRoute:string, 
        portId?:string,
        args?:any[],
        key?:any,
        subInput?:boolean,
        blocking?:boolean,
        getTransferable?:boolean
    ) => {
        if(typeof sourceWorker === 'string') sourceWorker = this.workers[sourceWorker];
        if(typeof listenerWorker === 'string') listenerWorker = this.workers[listenerWorker];
        if(!portId) {
            portId = this.establishMessageChannel(sourceWorker.worker,listenerWorker.worker) as string;
        }
        return listenerWorker.run('subscribeToWorker',[sourceRoute,portId,listenerRoute,args,key,subInput,blocking,getTransferable]) as Promise<number>; //just run .unsubscribe on worker2.
    }

    unpipeWorkers = (
        sourceRoute:string,
        sourceWorker:WorkerInfo|string,
        sub?:number
    ) => {
        if(typeof sourceWorker === 'string') sourceWorker = this.workers[sourceWorker];
        if(typeof sourceWorker === 'object') {
            //console.log(sourceWorker,sourceRoute);
            return sourceWorker.run('unsubscribe',[sourceRoute,sub]);
        }
    }

}