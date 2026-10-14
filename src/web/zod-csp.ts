// Imported first by main.tsx. Zod probes `new Function('')` to decide whether it may compile fast
// parsers; under our strict CSP (no 'unsafe-eval') the probe is caught but still reported as a
// violation. Opting out of the JIT keeps the console and violation reports clean.
import { z } from 'zod';

z.config({ jitless: true });
