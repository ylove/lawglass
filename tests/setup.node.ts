// Node tests use a mock dispatcher so outbound HTTP fails before connecting.
import { afterAll } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';

const previousDispatcher = getGlobalDispatcher();
const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect('127.0.0.1');
agent.enableNetConnect('localhost');
setGlobalDispatcher(agent);

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await agent.close();
});
