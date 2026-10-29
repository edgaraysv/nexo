import test from 'node:test';
import assert from 'node:assert/strict';
import { MemoryNodeRepository } from '../dist/product/node-repository.js';
import { MemoryOperationRepository } from '../dist/product/operation-repository.js';
import { runWorkerCycle } from '../dist/product/operation-worker.js';

const TENANT='55555555-5555-4555-8555-555555555505',DEVICE='66666666-6666-4666-8666-666666666605',NODE='77777777-7777-4777-8777-777777777705',ACTOR='88888888-8888-4888-8888-888888888805';

test('F05 redelivers without duplicate execution and rejects stale or divergent acknowledgements',async()=>{
  const operations=new MemoryOperationRepository(),nodes=new MemoryNodeRepository(),expiresAt=Date.now()+60_000;
  const created=await operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-operation-0001',expiresAt,revision:1},ACTOR);
  const replay=await operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-operation-0001',expiresAt,revision:1},ACTOR);
  assert.equal(replay.id,created.id);
  await assert.rejects(()=>operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-operation-0001',expiresAt,revision:2},ACTOR),/idempotency_conflict/);
  const cycle=await runWorkerCycle(operations,nodes,'worker-restarted',10);
  assert.equal(cycle.endpoint.dispatched,1);
  const first=await operations.next(DEVICE),redelivery=await operations.next(DEVICE);
  assert.equal(first.id,created.id);assert.equal(redelivery.id,created.id);assert.equal(first.deliveryAttempts,1);
  const result={os:'linux',arch:'amd64',go_version:'go1.27.3'},observedAt=new Date().toISOString();
  assert.equal(await operations.complete(DEVICE,created.id,{status:'succeeded',result,observedAt,revision:0}),false);
  assert.equal(await operations.complete(DEVICE,created.id,{status:'succeeded',result,observedAt,revision:1}),true);
  assert.equal(await operations.complete(DEVICE,created.id,{status:'succeeded',result,observedAt,revision:1}),true);
  assert.equal(await operations.complete(DEVICE,created.id,{status:'failed',result:{code:'execution_error'},observedAt,revision:1}),false);
  const failing=await operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-operation-0002',expiresAt,revision:2},ACTOR);
  await operations.dispatch('worker-errors',10);
  assert.equal(await operations.complete(DEVICE,failing.id,{status:'failed',result:{code:'execution_error'},observedAt,revision:2}),true);
  assert.equal((await operations.list(TENANT,{limit:100,offset:0})).items.find(item=>item.id===failing.id).errorCode,'execution_error');
});

test('F05 resumes queued work after worker interruption and expires disconnected targets',async()=>{
  const operations=new MemoryOperationRepository(),nodes=new MemoryNodeRepository();
  const pending=await nodes.createOperation({targetNodeId:NODE,idempotencyKey:'f05-node-pending-01',expiresAt:Date.now()+60_000,revision:1},ACTOR);
  assert.equal((await nodes.listOperations())[0].status,'queued');
  const resumed=await runWorkerCycle(operations,nodes,'worker-after-restart',10);
  assert.equal(resumed.node.dispatched,1);
  assert.equal((await nodes.next(NODE)).id,pending.id);
  assert.equal((await nodes.next(NODE)).id,pending.id);

  const expiring=await operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-expiring-0001',expiresAt:Date.now()+5,revision:1},ACTOR);
  await new Promise(resolve=>setTimeout(resolve,10));
  const reconciled=await runWorkerCycle(operations,nodes,'worker-reconcile',10);
  assert.equal(reconciled.endpoint.expired,1);
  assert.equal((await operations.list(TENANT,{limit:100,offset:0})).items.find(item=>item.id===expiring.id).status,'expired');
  assert.equal(await operations.next(DEVICE),undefined);
});

test('F05 enforces monotonic revisions independently for endpoint and provider node',async()=>{
  const operations=new MemoryOperationRepository(),nodes=new MemoryNodeRepository(),expiresAt=Date.now()+60_000;
  await operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-endpoint-r2',expiresAt,revision:2},ACTOR);
  await assert.rejects(()=>operations.create(TENANT,{targetDeviceId:DEVICE,type:'endpoint.runtime_info.v1',idempotencyKey:'f05-endpoint-r1',expiresAt,revision:1},ACTOR),/stale_revision/);
  await nodes.createOperation({targetNodeId:NODE,idempotencyKey:'f05-node-r3-0001',expiresAt,revision:3},ACTOR);
  await assert.rejects(()=>nodes.createOperation({targetNodeId:NODE,idempotencyKey:'f05-node-r2-0001',expiresAt,revision:2},ACTOR),/stale_revision/);
});
