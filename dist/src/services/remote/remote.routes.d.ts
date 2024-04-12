import { GraphNodeProperties } from "graphscript-core";
export declare const nodeTemplates: {};
export declare const remoteGraphRoutes: {
    transferNode: (properties: Function | (GraphNodeProperties & {
        __methods?: {
            [key: string]: Function | string;
        };
    }) | string, connection: any | Worker | WebSocket, name?: string) => any;
    setNode: (properties: string | ((...args: []) => any) | (GraphNodeProperties & {
        __methods?: {
            [key: string]: Function | string;
        };
    }), name?: string) => any;
    makeNodeTransferrable: (properties: GraphNodeProperties, name?: string) => {};
    getListenerJSON: () => any;
    makeRootTransferrable: () => {};
    setTemplate: (properties: string | ((...args: []) => any) | (GraphNodeProperties & {
        __methods?: {
            [key: string]: Function | string;
        };
    }), name?: string) => string | false;
    loadFromTemplate: (templateName: string, name?: string, properties?: {
        [key: string]: any;
    }) => any;
    setMethod: (nodeTag: string, fn: string | ((...args: []) => any), methodKey?: string) => boolean;
    assignNode: (nodeTag: string, source: {
        [key: string]: any;
    }) => void;
    getNodeProperties: (nodeTag: string) => {};
    proxyRemoteNode: (name: string, connection: any) => Promise<any>;
    transferClass: (classObj: any, connection: any | Worker | WebSocket, className?: string) => any;
    receiveClass: (stringified: string, className?: string) => boolean;
    transferFunction: (fn: Function, connection: any | Worker | WebSocket, fnName?: string) => any;
    setGlobal: (key: string, value: any) => boolean;
    assignGlobalObject: (target: string, source: {
        [key: string]: any;
    }) => boolean;
    setValue: (key: string, value: any) => boolean;
    assignObject: (target: string, source: {
        [key: string]: any;
    }) => boolean;
    setGlobalFunction: (fn: any, fnName?: string) => boolean;
    setGraphFunction: (fn: any, fnName?: string) => boolean;
};
