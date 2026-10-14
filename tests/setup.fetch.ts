import { afterAll } from 'vitest';
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici';
import ipaddr from 'ipaddr.js';
import { isIP } from 'node:net';

// Undici matches host + port, including ports assigned by listen(0).
const previousDispatcher = getGlobalDispatcher();
const agent = new MockAgent();
agent.disableNetConnect();
agent.enableNetConnect((authority) => {
  const match = /^(?:\[([^\]]+)\]|([^:]+))(?::\d+)?$/.exec(authority);
  const address = match?.[1] ?? match?.[2] ?? '';
  if (address.includes('%')) return false;
  const canonical =
    isIP(address) === 6
      ? new URL(`http://[${address}]`).hostname.slice(1, -1)
      : address;
  return (
    address === 'localhost' ||
    (Boolean(isIP(address)) &&
      !address.includes('%') &&
      ipaddr.process(canonical).range() === 'loopback')
  );
});
setGlobalDispatcher(agent);

afterAll(async () => {
  setGlobalDispatcher(previousDispatcher);
  await agent.close();
});
