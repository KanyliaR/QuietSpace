"""Standalone localhost calibration service. No QuietSpace imports or production calls."""
import argparse, datetime, hmac, http.server, json, math, os, pathlib, secrets, threading, time, uuid
ROOT = pathlib.Path(__file__).resolve().parents[1]
LABELS = ('quiet', 'moderate', 'loud')
def integer(value): return isinstance(value, int) and not isinstance(value, bool)
def thresholds(y, r):
    if not integer(y) or not integer(r) or not 0 <= y < r <= 500: raise ValueError('Use integer thresholds with 0 <= yellow < red <= 500')
def valid_config(config):
    if not isinstance(config,dict): raise ValueError('Invalid configuration object')
    thresholds(config.get('yellowThreshold'),config.get('redThreshold'))
    for key,value in {'schemaVersion':1,'measurementScale':'quietspace-rms-x500','smoothingWindowSeconds':3,'evaluationIntervalSeconds':1,'source':'raspberry-pi-calibration','implementationVersion':'byte-rms-x500-v1','scope':'shared-all-three-pis'}.items():
        if config.get(key)!=value: raise ValueError('Incompatible configuration '+key)
    if not isinstance(config.get('configurationVersion'),str) or not config['configurationVersion'] or not isinstance(config.get('calibratedAt'),str): raise ValueError('Missing configuration metadata')
    return config
def percentile(values, fraction):
    values = sorted(values); x = (len(values)-1)*fraction; i = int(x)
    return values[i]+(values[min(i+1,len(values)-1)]-values[i])*(x-i)
def analyze(sessions, yellow, red):
    thresholds(yellow, red); result=[]
    for label in LABELS:
        values=[p['smoothed'] for s in sessions if s['label']==label and not s.get('excluded') and s['status']=='complete' for p in s['points'] if p['ready']]
        if len(values)<10: raise ValueError('At least 10 full-window readings per category are required')
        correct=sum((0 if v<yellow else 1 if v<red else 2)==LABELS.index(label) for v in values)
        result.append({'label':label,'count':len(values),'correct':correct,'incorrect':len(values)-correct,'accuracy':correct/len(values),'median':percentile(values,.5),'p05':percentile(values,.05),'p95':percentile(values,.95)})
    return {'balancedAccuracy':sum(c['accuracy'] for c in result)/3,'categories':result}
def bytes_level(values):
    if not len(values): raise ValueError('Empty audio buffer')
    return math.floor(math.sqrt(sum(((int(v)-128)/128)**2 for v in values)/len(values))*500+.5)
class Processor:
    def __init__(self): self.reset()
    def reset(self): self.points=[]; self.start=None; self.last=None; self.evaluation=-math.inf
    def push(self, values, timestamp):
        if self.last is not None and (timestamp<=self.last or timestamp-self.last>500): self.reset()
        self.last=timestamp
        if self.start is None: self.start=timestamp
        instant=bytes_level(values); self.points.append((timestamp,instant)); self.points=[p for p in self.points if timestamp-p[0]<=3000]
        if timestamp-self.evaluation<1000: return None
        self.evaluation=timestamp
        return {'time':timestamp,'instant':instant,'smoothed':math.floor(sum(p[1] for p in self.points)/len(self.points)+.5),'ready':timestamp-self.start>=3000}
class Calibration:
    def __init__(self, directory):
        self.directory=pathlib.Path(directory); self.lock=threading.RLock(); self.sessions=[]; self.current=None; self.stop_event=threading.Event(); self.revision=0; self.device=''; self.lease=0; self.thread=None
    def invalidate(self): self.revision+=1
    def start(self, body):
        models=[pathlib.Path('/proc/device-tree/model'),pathlib.Path('/sys/firmware/devicetree/base/model')]
        if not any(p.exists() and 'Raspberry Pi' in p.read_text(errors='ignore') for p in models): raise ValueError('Actual calibration requires this service to run on a Raspberry Pi; Laptop Mode is available for browser testing')
        if body.get('label') not in LABELS or body.get('duration') not in (30,45,60): raise ValueError('Choose a labeled 30, 45 or 60 second test')
        if body.get('device') is not None and not integer(body['device']): raise ValueError('Invalid microphone selection')
        if self.current: raise ValueError('A capture is already running')
        import sounddevice as sd
        import numpy as np
        info=sd.query_devices(body.get('device'), 'input'); self.device=info['name']; rate=int(info['default_samplerate'])
        # Quantize to the browser byte scale before applying the identical x500 formula.
        stream=sd.InputStream(device=body.get('device'),channels=1,samplerate=rate,blocksize=2048,dtype='float32')
        stream.start(); self.stop_event.clear(); self.lease=time.monotonic()
        session={'id':uuid.uuid4().hex,'label':body['label'],'location':str(body.get('location',''))[:100], 'duration':0,'target':body['duration'],'points':[],'excluded':body.get('testing') is True,'status':'recording','microphone':self.device,'source':'pi','startedAt':datetime.datetime.now(datetime.timezone.utc).isoformat()}
        self.current=session; self.invalidate()
        def capture():
            processor=Processor(); started=time.monotonic(); last_sample=None
            try:
                while not self.stop_event.is_set() and time.monotonic()-started<body['duration']:
                    if time.monotonic()-self.lease>8: raise RuntimeError('Controller disconnected; capture stopped')
                    data, overflow=stream.read(2048)
                    if overflow: raise RuntimeError('Microphone input overflow; repeat this recording')
                    elapsed=(time.monotonic()-started)*1000
                    quantized=np.clip(np.floor(np.clip(data[:,0],-1,1)*128+128),0,255).astype(np.uint8)
                    point=processor.push(quantized,elapsed)
                    with self.lock:
                        session['duration']=elapsed/1000
                        if point: session['points'].append(point)
                with self.lock: session['status']='complete'
            except Exception as error:
                with self.lock: session['status']='interrupted';session['error']=str(error)
            finally:
                stream.stop();stream.close()
                with self.lock: self.sessions.append(session);self.current=None;self.invalidate()
        self.thread=threading.Thread(target=capture,daemon=True); self.thread.start()
        return {'microphone':self.device,'id':session['id']}
    def stop(self):
        self.stop_event.set()
        thread=self.thread
        if thread and thread.is_alive(): thread.join(timeout=4)
        if thread and thread.is_alive(): raise ValueError('Microphone is still stopping; try again')
    def edit(self, body):
        if self.current: raise ValueError('Stop capture before editing')
        session=next((s for s in self.sessions if s['id']==body.get('id')),None)
        if not session: raise ValueError('Session not found')
        if body.get('action')=='delete': self.sessions.remove(session)
        elif body.get('action')=='exclude': session['excluded']=not session['excluded']
        else:
            if body.get('label') not in LABELS: raise ValueError('Invalid label')
            split=body.get('split')
            if split is not None and (not isinstance(split,(int,float)) or isinstance(split,bool) or not math.isfinite(split) or not 0<split<session['duration']): raise ValueError('Split must be inside the recording')
            if split is not None:
                left=[p for p in session['points'] if p['time']/1000<split]; right=[dict(p,time=p['time']-split*1000) for p in session['points'] if p['time']/1000>=split]
                if not left or not right: raise ValueError('Both split segments need observations')
                tail=dict(session,id=uuid.uuid4().hex,label=body['label'],points=right,duration=session['duration']-split);session['points']=left;session['duration']=split;self.sessions.append(tail)
            session['label']=body['label']
        self.invalidate()
    def versions(self):
        if not self.directory.exists(): return []
        result=[]
        for file in sorted(self.directory.glob('*.json'),reverse=True):
            try:
                config=valid_config(json.loads(file.read_text()));result.append(config)
            except (ValueError,KeyError,TypeError,OSError): pass
        return sorted(result,key=lambda v:v.get('calibratedAt',''),reverse=True)
    def save(self, body):
        if self.current: raise ValueError('Stop capture before approval')
        if body.get('revision')!=self.revision: raise ValueError('Recordings changed; reload and review again')
        y,r=body.get('yellow'),body.get('red');result=analyze(self.sessions,y,r)
        cats=result['categories']; uncertain=result['balancedAccuracy']<.8 or cats[0]['p95']>=cats[1]['p05'] or cats[1]['p95']>=cats[2]['p05'] or not cats[0]['median']<cats[1]['median']<cats[2]['median']
        if uncertain and body.get('acknowledgeWarnings') is not True: raise ValueError('Acknowledge overlapping or ambiguous calibration results before approval')
        return self.write_config(y,r,{'analysis':result,'microphones':sorted(set(s['microphone'] for s in self.sessions if not s['excluded']))})
    def write_config(self,y,r,metadata):
        thresholds(y,r); now=datetime.datetime.now(datetime.timezone.utc);version=now.strftime('%Y%m%dT%H%M%S')+'-'+uuid.uuid4().hex[:12]
        config={'schemaVersion':1,'measurementScale':'quietspace-rms-x500','yellowThreshold':y,'redThreshold':r,'smoothingWindowSeconds':3,'evaluationIntervalSeconds':1,'source':'raspberry-pi-calibration','calibratedAt':now.isoformat(),'configurationVersion':version,'implementationVersion':'byte-rms-x500-v1','scope':'shared-all-three-pis',**metadata}
        self.directory.mkdir(mode=0o700,parents=True,exist_ok=True);os.chmod(self.directory,0o700);temp=self.directory/(version+'.tmp');target=self.directory/(version+'.json')
        try:
            with open(temp,'x') as file: os.chmod(temp,0o600);json.dump(config,file,indent=2);file.flush();os.fsync(file.fileno())
            os.replace(temp,target)
        finally:
            if temp.exists():temp.unlink()
        return config
class Server(http.server.ThreadingHTTPServer): daemon_threads=True
class Handler(http.server.BaseHTTPRequestHandler):
    def log_message(self,*args): pass
    def respond(self,value,status=200):
        raw=json.dumps(value).encode();self.send_response(status);self.send_header('Content-Type','application/json');self.send_header('Cache-Control','no-store');self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(raw)
    def authorized(self):
        host=self.headers.get('Host','')
        if host not in self.server.allowed_hosts: self.respond({'error':'Host denied'},403);return False
        origin=self.headers.get('Origin')
        if origin and origin!='http://'+host: self.respond({'error':'Origin denied'},403);return False
        if not hmac.compare_digest(self.headers.get('Authorization',''),'Bearer '+self.server.token):self.respond({'error':'Pi service access token required'},401);return False
        return True
    def do_GET(self):
        if self.path.startswith('/api/'):
            if not self.authorized():return
            try:
                c=self.server.calibration
                with c.lock:
                    if self.path=='/api/status':
                        devices=[]
                        try:
                            import sounddevice as sd
                            devices=[{'id':i,'name':d['name']} for i,d in enumerate(sd.query_devices()) if d['max_input_channels']>0]
                        except Exception as e:return self.respond({'error':'Pi audio unavailable: '+str(e)},503)
                        return self.respond({'devices':devices,'revision':c.revision,'microphone':c.device,'source':'pi'})
                    if self.path=='/api/data':c.lease=time.monotonic();return self.respond({'current':c.current,'sessions':c.sessions,'revision':c.revision})
                    if self.path=='/api/configs':return self.respond(c.versions())
                    if self.path.startswith('/api/configs/'):
                        version=self.path.rsplit('/',1)[1];config=next((v for v in c.versions() if v['configurationVersion']==version),None)
                        if not config:raise ValueError('Approved version not found')
                        return self.respond(config)
                self.respond({'error':'Unknown API'},404)
            except Exception as e:self.respond({'error':str(e)},400)
            return
        file={'/':'index.html','/index.html':'index.html','/calibration.css':'calibration.css','/calibration.js':'calibration.js','/analysis.js':'analysis.js','/audio/laptop.js':'audio/laptop.js'}.get(self.path.split('?')[0])
        if not file:self.send_error(404);return
        raw=(ROOT/file).read_bytes();self.send_response(200);self.send_header('Content-Type','text/html' if file.endswith('html') else 'text/css' if file.endswith('css') else 'text/javascript');self.send_header('Cache-Control','no-store');self.send_header('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; media-src 'self'; frame-ancestors 'none'");self.send_header('X-Content-Type-Options','nosniff');self.end_headers();self.wfile.write(raw)
    def do_POST(self):
        if not self.authorized():return
        try:
            size=int(self.headers.get('Content-Length','0'))
            if not 0<size<=4096:raise ValueError('Request body size invalid')
            body=json.loads(self.rfile.read(size))
            if not isinstance(body,dict) or body.get('mode')!='pi':raise ValueError('Only Pi Mode commands are permitted')
            c=self.server.calibration
            if self.path=='/api/stop':c.stop();return self.respond({'stopped':True})
            if self.path=='/api/reset':c.stop()
            with c.lock:
                if self.path=='/api/start':return self.respond(c.start(body))
                if self.path=='/api/edit':c.edit(body);return self.respond({'updated':True})
                if self.path=='/api/reset':c.sessions=[];c.invalidate();return self.respond({'reset':True})
                if self.path=='/api/approve':return self.respond(c.save(body),201)
                if self.path=='/api/restore':
                    if c.current:raise ValueError('Stop capture before restoring a configuration')
                    prior=next((v for v in c.versions() if v['configurationVersion']==body.get('version')),None)
                    if not prior:raise ValueError('Approved version not found')
                    return self.respond(c.write_config(prior['yellowThreshold'],prior['redThreshold'],{'restoredFrom':prior['configurationVersion'],'microphones':prior.get('microphones',[]),'analysis':prior.get('analysis')}),201)
            self.respond({'error':'Unknown command'},404)
        except ImportError:self.respond({'error':'Install Pi audio dependencies from requirements-pi.txt'},503)
        except Exception as e:self.respond({'error':str(e)},400)
def main():
    parser=argparse.ArgumentParser();parser.add_argument('--port',type=int,default=8765);parser.add_argument('--config-dir',default=str(ROOT/'config'));args=parser.parse_args()
    token=os.environ.get('QUIETSPACE_CALIBRATION_TOKEN') or secrets.token_urlsafe(32)
    if len(token)<24:raise SystemExit('Use a service token of at least 24 characters')
    server=Server(('127.0.0.1',args.port),Handler);server.token=token;server.allowed_hosts={f'127.0.0.1:{args.port}',f'localhost:{args.port}'};server.calibration=Calibration(args.config_dir)
    print(f'Calibration utility: http://127.0.0.1:{args.port}\nAccess token (keep private): {token}',flush=True)
    try:server.serve_forever()
    except KeyboardInterrupt:pass
    finally:server.calibration.stop();server.server_close()
if __name__=='__main__':main()
