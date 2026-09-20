import express from 'express';
import {fileURLToPath} from 'node:url';
import {RuleStore, SnapshotStore} from './store';
import {BatchManager} from './batch';
import {ReportStore} from './reports';
import {createSuppressionRouter} from './routes';
import {SAMPLE_SNAPSHOTS, seedRules} from './seed';

type RecordRow = {id:string;name:string;revision:number;content:string;updatedAt:string};
const rows: RecordRow[] = [
  {id:'alpha',name:'Primary review findings',revision:3,content:'review findings: alpha\nstate: active',updatedAt:new Date(0).toISOString()},
  {id:'beta',name:'Secondary review findings',revision:5,content:'review findings: beta\nstate: review',updatedAt:new Date(1000).toISOString()},
];

export interface Workbench {
  app: ReturnType<typeof express>;
  rules: RuleStore;
  snapshots: SnapshotStore;
  batches: BatchManager;
  reports: ReportStore;
  clock: () => number;
  /** 测试/演示可拨动时钟 */
  setClock(fn: () => number): void;
}

export function createWorkbench(now = Date.parse('2026-09-20T12:00:00.000Z')): Workbench {
  let clock = () => now;
  const app = express();
  app.use(express.json({limit:'1mb'}));

  app.get('/api/bootstrap',(_req,res)=>res.json({family:"accessibility-review",count:rows.length}));
  app.get('/api/audits',(_req,res)=>res.json(rows.map(({content,...row})=>row)));
  app.get('/api/audits/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});res.set('ETag',String(row.revision)).json(row)});
  app.put('/api/audits/:id',(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});if(req.body.revision!==row.revision)return res.status(409).json({error:'revision_conflict',current:row});row.content=String(req.body.content??'');row.revision+=1;row.updatedAt=new Date().toISOString();res.json(row)});
  app.post('/api/audits/:id/analyze',async(req,res)=>{const row=rows.find(value=>value.id===req.params.id);if(!row)return res.status(404).json({error:'not_found'});await new Promise(resolve=>setTimeout(resolve,req.params.id==='alpha'?100:20));res.json({id:row.id,revision:row.revision,lines:String(req.body.content??row.content).split(/\r?\n/).length,diagnostics:[]})});

  // ---- 无障碍问题抑制规则工作台（仅静态样例，不连线上系统） ----
  const rules = new RuleStore(() => clock());
  const snapshots = new SnapshotStore(SAMPLE_SNAPSHOTS);
  seedRules(rules);
  const reports = new ReportStore();
  const batches = new BatchManager(rules, snapshots, () => clock(), {
    delayMs: 30,
    onComplete: (report) => reports.save(report),
  });

  app.use('/api/suppression', createSuppressionRouter({rules, snapshots, batches, reports, clock: () => clock()}));

  return {
    app,
    rules,
    snapshots,
    batches,
    reports,
    clock: () => clock(),
    setClock(fn: () => number) { clock = fn; },
  };
}

export function createApp(){ return createWorkbench().app; }

if(process.argv[1]===fileURLToPath(import.meta.url)){createApp().listen(4174,'127.0.0.1',()=>console.log('server http://127.0.0.1:4174'))}
