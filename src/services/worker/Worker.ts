//functionality
import { WorkerService } from './Worker.service';
//import { GPUService } from '../gpu/GPU.service';
import { workerCanvasRoutes } from 'workercanvas';
import { remoteGraphRoutes } from '../remote/remote.routes';

//wonder if we can have a scheme to dynamic import within the services? e.g. to bring in node-only or browser-only services without additional workers

declare var WorkerGlobalScope;

if(typeof WorkerGlobalScope !== 'undefined' && self instanceof WorkerGlobalScope) {
    (self as any).SERVICE = new WorkerService({
        services:{
            workerCanvasRoutes,
            remoteGraphRoutes, //allows dynamic route loading
            Math
        }
    });
    
}

export default self as any;