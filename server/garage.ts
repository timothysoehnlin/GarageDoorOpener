import * as http from 'http';
import * as express from 'express';
import * as proc from 'child_process';
import * as rpio from 'rpio';
import { config } from './firebase';
import Storage = require('@google-cloud/storage');

export class Garage {

  static DOOR = 18
  static SNAPSHOT_TIMER: any;
  static SNAPSHOT_LOCK: boolean = false;
  static PATH = 'images/door-snap.jpg';
  static SNAPSHOT_URL = `https://storage.googleapis.com/${config.projectId}/${Garage.PATH}`

  static killTimeout: NodeJS.Timer;
  static listening = 0;
  static cameraProc?: proc.ChildProcess = undefined;
  static cameraOptions = {
    x: 640,
    y: 480,
    fps: 15
  }

  static init() {
    rpio.open(this.DOOR, rpio.OUTPUT);
    process.on('exit', () => Garage.cleanup());
    process.on('SIGINT', () => Garage.cleanup());
    process.on('uncaughtException', () => Garage.cleanup());
  }

  static async triggerDoor(action?: string) {
    this.SNAPSHOT_TIMER = setTimeout(() => Garage.exposeSnapshot(), 20000); // Assume stable point after door opens/closes

    rpio.write(this.DOOR, rpio.HIGH);
    rpio.sleep(.5)
    rpio.write(this.DOOR, rpio.LOW);

    if (this.SNAPSHOT_TIMER) {
      clearTimeout(this.SNAPSHOT_TIMER);
    }
  }

  static cleanup() {
    if (this.cameraProc) {
      try {
        this.cameraProc.kill();
      } catch (e) {
        //Do nothing
      }
    }
    process.exit();
  }

  static async startCamera() {
    console.log("Starting Camera", this.listening);
    clearTimeout(this.killTimeout);
    if (!this.cameraProc) {
      let args = ['-o', 'output_http.so -w ./www', '-i', 'input_raspicam.so ' + Object.keys(Garage.cameraOptions)
        .map(x => `-${x} ${(Garage.cameraOptions as any)[x]}`).join(' ')];
      let env = {
        LD_LIBRARY_PATH: process.cwd(),
        ...process.env
      };

      this.cameraProc = proc.spawn('mjpg_streamer', args, {
        env,
        cwd: process.cwd()
      });
      this.cameraProc.stdout.pipe(process.stdout);
      this.cameraProc.stderr.pipe(process.stderr);
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
  }

  static async stopCamera() {
    console.log("Stopping Camera", this.listening);
    if (this.listening === 0 && this.cameraProc) {
      try {
        this.cameraProc.kill('SIGINT');
      } catch (e) {
        console.log("Cannot kill", e.message);
      }
      delete this.cameraProc;
    }
  }

  static async camera(response: NodeJS.WritableStream, action: 'stream' | 'snapshot' = 'stream') {
    let closed = false, close = (type: string, key: string) => {
      console.log("Closing", type, key);
      if (closed) {
        return;
      }
      this.listening--;
      closed = true;
      console.log("Camera Request End", this.listening);
      this.killTimeout = setTimeout(() => this.stopCamera(), 1000 * 30);
    };

    this.listening++;
    console.log("Camera Request Start", this.listening);
    await this.startCamera();

    let req = http.request({
      port: 8080,
      host: 'localhost',
      path: `/?action=${action}`
    }, (res) => {
      if ('writeHead' in response) {
        (response as express.Response).writeHead(res.statusCode || 200, res.headers);
      }
      return res.pipe(response, { end: true });
    });

    response.on('close', (x: any) => close('close', x));
    req.on('error', (x: any) => close('error', x));
    response.on('error', (x: any) => close('error', x));
    response.on('finish', (x: any) => close('finish', x));

    req.end();
  }

  static async exposeSnapshot() {
    if (Garage.SNAPSHOT_LOCK) {
      return Garage.SNAPSHOT_URL;
    }
    Garage.SNAPSHOT_LOCK = true;

    const st = Storage({
      keyFilename: '../google-services.json'
    });

    let bucket = await st.bucket(config.storageBucket.split('gs://')[1]);

    let file = bucket.file(`/${Garage.PATH}`);

    const stream = file.createWriteStream({
      metadata: {
        contentType: 'image/jpeg'
      }
    });

    try {
      let res = await new Promise((resolve, reject) => {
        stream.on('error', reject);
        stream.on('finish', () => {
          file.makePublic()
            .then(x => Garage.SNAPSHOT_URL)
            .then(resolve, reject);
        });
        try {
          Garage.camera(stream, 'snapshot');
        } catch (e) {
          reject(e);
        }
      });

      return res;
    } finally {
      Garage.SNAPSHOT_LOCK = false;
    }
  }
}