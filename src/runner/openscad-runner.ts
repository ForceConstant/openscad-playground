// Portions of this file are Copyright 2021 Google LLC, and licensed under GPL2+. See COPYING.

import { MergedOutputs } from "./openscad-worker.ts";
import { AbortablePromise } from "../utils.ts";
import { Source } from "../state/app-state.ts";

export type OpenSCADInvocation = {
  mountArchives: boolean,
  inputs?: Source[],
  args: string[],
  outputPaths?: string[],
}

export type OpenSCADInvocationResults = {
  exitCode?: number,
  error?: string,
  outputs?: [string, string][],
  mergedOutputs: MergedOutputs,
  elapsedMillis: number,
};

export type ProcessStreams = {stderr: string} | {stdout: string}
export type OpenSCADInvocationCallback = {result: OpenSCADInvocationResults} | ProcessStreams;

export function spawnOpenSCAD(
  invocation: OpenSCADInvocation, 
  streamsCallback: (ps: ProcessStreams) => void
): AbortablePromise<OpenSCADInvocationResults> {
  let worker: Worker | null;
  let rejection: (err: any) => void;

  function terminate() {
    if (!worker) {
      return;
    }
    worker.terminate();
    worker = null;
  }
    
  return AbortablePromise<OpenSCADInvocationResults>((resolve: (result: OpenSCADInvocationResults) => void, reject: (error: any) => void) => {
    // Stamp the worker URL with the build version so each release fetches a
    // fresh worker. A worker script fetch is not refreshed by a normal page
    // reload (nor by the hard-reload cache bypass in Chrome), so without this
    // a browser can keep running a *previous* worker build after the app
    // bundle itself has updated — which silently defeats fixes to the worker
    // (e.g. the OpenSCAD FS write path) until the site data is cleared.
    worker = new Worker(`./openscad-worker.js?v=${process.env.APP_VERSION ?? 'dev'}`);//, { type: 'module' });
    rejection = reject;
    worker.onmessage = (e: MessageEvent<OpenSCADInvocationCallback>) => {
      if ('result' in e.data) {
        resolve(e.data.result);
        terminate();
      } else {
        streamsCallback(e.data);
      }
    }
    worker.postMessage(invocation)
    
    return () => {
      terminate();
    };
  });
}
