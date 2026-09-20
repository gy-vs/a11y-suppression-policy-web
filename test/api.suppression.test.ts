import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { createWorkbench } from '../src/server/index';

const base = '/api/suppression';

describe('规则 REST 与并发', () => {
  it('创建（含非法规则）、列表带 valid、乐观并发 409、编辑产生新 revision', async () => {
    const app = createWorkbench().app;

    const created = await request(app)
      .post(`${base}/rules`)
      .send({ ruleCode: 'label', reason: '临时' })
      .expect(201);
    const id = created.body.rule.ruleId;
    expect(created.body.rule.revision).toBe(1);
    expect(created.body.rule.valid).toBe(true);

    // 非法规则也持久化
    const bad = await request(app)
      .post(`${base}/rules`)
      .send({ ruleCode: 'label', reason: 'x', expiresAt: 'bad' })
      .expect(201);
    expect(bad.body.rule.valid).toBe(false);

    // 缺 expectedRevision
    await request(app).put(`${base}/rules/${id}`).send({ reason: '改' }).expect(400);

    const v2 = await request(app)
      .put(`${base}/rules/${id}`)
      .send({ reason: '改', ruleCode: 'label', expectedRevision: 1 })
      .expect(200);
    expect(v2.body.rule.revision).toBe(2);

    // 陈旧 revision -> 409，并回传 current
    const conflict = await request(app)
      .put(`${base}/rules/${id}`)
      .send({ reason: '陈旧', ruleCode: 'label', expectedRevision: 1 })
      .expect(409);
    expect(conflict.body.current.revision).toBe(2);

    // 禁用
    await request(app).post(`${base}/rules/${id}/enabled`).send({ enabled: false, expectedRevision: 2 }).expect(200);
    const got = await request(app).get(`${base}/rules/${id}`).expect(200);
    expect(got.body.rule.enabled).toBe(false);
    expect(got.body.rule.revision).toBe(3);
    expect(got.body.history.map((h: { revision: number }) => h.revision)).toEqual([1, 2, 3]);
  });
});

describe('即时评估与时钟边界', () => {
  it('?at 控制时钟：到期前 suppressed，到期瞬间 expired', async () => {
    const app = createWorkbench().app;
    const snap = 'snap-home-q4';
    const before = await request(app)
      .post(`${base}/snapshots/${snap}/evaluate?at=2026-08-31T23:59:58.000Z`)
      .send({})
      .expect(200);
    const navBefore = before.body.result.decisions.find((d: { issueId: string }) => d.issueId === 'i-nav-unique');
    expect(navBefore.outcome).toBe('suppressed');

    const at = await request(app)
      .post(`${base}/snapshots/${snap}/evaluate`)
      .send({ at: '2026-08-31T23:59:59.000Z' })
      .expect(200);
    const navAt = at.body.result.decisions.find((d: { issueId: string }) => d.issueId === 'i-nav-unique');
    expect(navAt.outcome).toBe('expired');

    await request(app).post(`${base}/snapshots/${snap}/evaluate`).send({ at: 'nope' }).expect(400);
  });
});

async function collectSSE(app: ReturnType<typeof createWorkbench>['app'], path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const http = require('node:http') as typeof import('node:http');
    http
      .get(`http://127.0.0.1:${port}${path}`, (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c.toString()));
        res.on('end', () => {
          server.close();
          resolve(buf);
        });
      })
      .on('error', reject);
  });
}

describe('批量 SSE：重连不重复计数', () => {
  it('完成后一次性流含 started/items/completed，且无重复序号', async () => {
    const wb = createWorkbench();
    const started = await request(wb.app).post(`${base}/batches`).send({}).expect(202);
    const batchId = started.body.batchId;
    // 等待完成（服务端 delay 30ms × 3）
    await new Promise((r) => setTimeout(r, 250));

    const buf = await collectSSE(wb.app, `${base}/batches/${batchId}/events`);
    const ids = [...buf.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(ids).toEqual([...new Set(ids)]); // 序号唯一
    expect(buf).toContain('event: completed');
  });

  it('带 lastEventId 重连只收到后续事件，最终累计不翻倍', async () => {
    const wb = createWorkbench();
    const started = await request(wb.app).post(`${base}/batches`).send({}).expect(202);
    const batchId = started.body.batchId;
    await new Promise((r) => setTimeout(r, 250));

    const full = await collectSSE(wb.app, `${base}/batches/${batchId}/events`);
    const tail = await collectSSE(wb.app, `${base}/batches/${batchId}/events?lastEventId=2`);

    // 重放流的第一个 id 是 3
    const tailIds = [...tail.matchAll(/^id: (\d+)$/gm)].map((m) => Number(m[1]));
    expect(tailIds[0]).toBe(3);

    const parseCumulative = (buf: string) => {
      const datas = [...buf.matchAll(/^data: (\{.*\})$/gm)].map((m) => JSON.parse(m[1]));
      const completed = datas.find((d) => d.type === 'completed');
      return completed.cumulative as Record<string, number>;
    };
    // 重连后的 completed 全量累计与全量流一致（覆盖语义，不是叠加）
    expect(parseCumulative(tail)).toEqual(parseCumulative(full));
  });
});

describe('批量取消：不写部分最终统计', () => {
  it('取消返回 canceled，无报告，无 completed', async () => {
    const wb = createWorkbench(); // delay 30ms
    const started = await request(wb.app).post(`${base}/batches`).send({ snapshotIds: ['snap-home-q4', 'snap-report-q3', 'snap-report-q3-fixed'] }).expect(202);
    const batchId = started.body.batchId;
    await new Promise((r) => setTimeout(r, 45)); // 至少处理 1 个

    await request(wb.app).post(`${base}/batches/${batchId}/cancel`).expect(200);
    await new Promise((r) => setTimeout(r, 150));

    const status = await request(wb.app).get(`${base}/batches/${batchId}`).expect(200);
    expect(status.body.status).toBe('canceled');
    expect(status.body.reportId).toBeUndefined();

    const reports = await request(wb.app).get(`${base}/reports`).expect(200);
    expect(reports.body.reports).toEqual([]);
  });
});

describe('历史报告回放', () => {
  it('完成批量后编辑规则，回放仍逐字段匹配已存结论', async () => {
    const wb = createWorkbench();
    const started = await request(wb.app).post(`${base}/batches`).send({}).expect(202);
    const batchId = started.body.batchId;
    await new Promise((r) => setTimeout(r, 250));

    const status = await request(wb.app).get(`${base}/batches/${batchId}`).expect(200);
    const reportId = status.body.reportId;
    expect(reportId).toBeTruthy();
    const before = await request(wb.app).get(`${base}/reports/${reportId}`).expect(200);

    // 之后编辑规则（收窄作用域），不应影响回放
    await request(wb.app)
      .put(`${base}/rules/rule-third-party`)
      .send({ reason: '改', fingerprint: 'fp:gone', pathPattern: '/home', ruleCode: 'aria-required-attr', expectedRevision: 1 })
      .expect(200);

    const replay = await request(wb.app).post(`${base}/reports/${reportId}/replay`).expect(200);
    expect(replay.body.matchesStored).toBe(true);
    expect(replay.body.report.decisions).toEqual(before.body.report.decisions);
  });
});
