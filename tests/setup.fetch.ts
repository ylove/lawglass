import { afterAll } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';

// Undici matches host + port, including ports assigned by listen(0).
const previousDispatcher = getGlobalDispatcher();
const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect(/^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/);
setGlobalDispatcher(agent);

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await agent.close();
});
