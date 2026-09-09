import { readFileSync } from 'node:fs';
import { join } from 'node:path';
const file = process.env.CLAUDE_EXECUTION_FILE || join(process.env.RUNNER_TEMP, 'claude-execution-output.json');
let category = 'execution failure (diagnostic unavailable)';
try {
  const events = JSON.parse(readFileSync(file, 'utf8'));
  const results = (Array.isArray(events) ? events : [events]).filter(event => event.type === 'result' || event.type === 'assistant');
  const text = JSON.stringify(results);
  // SDK transcripts can contain credentials; publish only a fixed category.
  category = /oauth|expired|authentication|unauthorized|not logged in|invalid.*token|401/i.test(text) ? 'authentication unavailable or expired'
    : /rate.limit|usage.limit|quota|429|credit/i.test(text) ? 'account usage limit'
    : /model.*not.found|model.*not.*available|404/i.test(text) ? 'model unavailable'
    : /permission|forbidden|403/i.test(text) ? 'permission denied'
    : /timeout|timed out|connection|fetch failed/i.test(text) ? 'network or timeout'
    : 'execution failure (unclassified)';
} catch {}
console.log(`::notice::Claude review failed: ${category}. The review check remains failed.`);
