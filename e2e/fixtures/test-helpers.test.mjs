import assert from 'node:assert/strict';
import test from 'node:test';
import { registerHooks } from 'node:module';

const socketModule = 'data:text/javascript,' + encodeURIComponent(`
  import { EventEmitter } from 'node:events';
  export default class FakeWebSocket extends EventEmitter {
    static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
    static instances = [];
    readyState = 0;
    constructor(url) { super(); this.url = url; FakeWebSocket.instances.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    close(code) {
      this.closeCode = code;
      this.readyState = 3;
      queueMicrotask(() => this.emit('close'));
    }
    terminate() { this.terminated = true; this.close(); }
  }
`);
const hooks = registerHooks({ resolve(specifier, context, next) {
  return specifier === 'ws' ? { url: socketModule, shortCircuit: true } : next(specifier, context);
} });
process.env.MAILPIT_API = 'http://127.0.0.1:8025/api';
const { onMailpitMessage } = await import('./test-helpers.ts');
const { default: FakeWebSocket } = await import(socketModule);
hooks.deregister();

function observe(promise) {
  const state = { status: 'pending' };
  promise.then(value => Object.assign(state, { status: 'fulfilled', value }),
    error => Object.assign(state, { status: 'rejected', error }));
  return state;
}

function fixture(t, predicate = message => message.Subject === 'expected') {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const listener = onMailpitMessage(predicate, { timeout: 100 });
  const socket = FakeWebSocket.instances.at(-1);
  t.after(() => socket.close());
  return { socket, ready: observe(listener.ready), message: observe(listener.message) };
}

const event = (subject, type = 'new') => JSON.stringify({ Type: type, Data: { Subject: subject } });

test('a matching message resolves and closes the subscription normally', async t => {
  const { socket, ready, message } = fixture(t);
  socket.open();
  socket.emit('message', Buffer.from(event('expected')));
  await Promise.resolve();
  assert.equal(ready.status, 'fulfilled');
  assert.deepEqual(message.value, { Subject: 'expected' });
  assert.equal(socket.closeCode, 1000);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(message.status, 'fulfilled');
});

test('Mailpit newline-delimited batched events do not lose a matching delivery', async t => {
  const { socket, message } = fixture(t);
  socket.open();
  socket.emit('message', Buffer.from([
    event('ignored', 'stats'), event('other'), event('expected'), event('later'),
  ].join('\n')));
  await Promise.resolve();
  assert.equal(message.status, 'fulfilled');
  assert.deepEqual(message.value, { Subject: 'expected' });
});

test('an escaped newline in a subject is data, not an event separator', async t => {
  const { socket, message } = fixture(t, value => value.Subject === 'line one\nline two');
  socket.open();
  socket.emit('message', Buffer.from(event('other') + '\n' + event('line one\nline two')));
  await Promise.resolve();
  assert.equal(message.status, 'fulfilled');
  assert.equal(message.value.Subject, 'line one\nline two');
});

test('malformed event frames fail immediately with the parser cause', async t => {
  const { socket, message } = fixture(t);
  socket.open();
  socket.emit('message', Buffer.from('{broken'));
  await Promise.resolve();
  assert.equal(message.status, 'rejected');
  assert.ok(message.error.cause instanceof SyntaxError);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});

test('predicate errors preserve their cause instead of becoming a timeout', async t => {
  const cause = new Error('predicate failed');
  const { socket, message } = fixture(t, () => { throw cause; });
  socket.open();
  socket.emit('message', Buffer.from(event('expected')));
  await Promise.resolve();
  assert.equal(message.status, 'rejected');
  assert.equal(message.error.cause, cause);
});

test('a connection timeout rejects readiness and delivery and terminates the socket', async t => {
  const { socket, ready, message } = fixture(t);
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(ready.status, 'rejected');
  assert.equal(message.status, 'rejected');
  assert.equal(ready.error, message.error);
  assert.match(message.error.message, /timeout/);
  assert.equal(socket.terminated, true);
});

test('closing before open rejects both promises without waiting for the deadline', async t => {
  const { socket, ready, message } = fixture(t);
  socket.close();
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(ready.status, 'rejected');
  assert.equal(message.status, 'rejected');
  assert.equal(ready.error, message.error);
  assert.match(message.error.message, /closed/);
});

test('transport failures retain the original error and release the pending connection', async t => {
  const cause = new Error('connect failed');
  const { socket, ready, message } = fixture(t);
  socket.emit('error', cause);
  await Promise.resolve();
  assert.equal(ready.error, cause);
  assert.equal(message.error, cause);
  assert.equal(socket.terminated, true);
});

test('a deadline after open rejects delivery while settled readiness remains successful', async t => {
  const { socket, ready, message } = fixture(t);
  socket.open();
  await Promise.resolve();
  t.mock.timers.tick(100);
  await Promise.resolve();
  assert.equal(ready.status, 'fulfilled');
  assert.equal(message.status, 'rejected');
  assert.match(message.error.message, /timeout/);
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
});
