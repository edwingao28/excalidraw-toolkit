import { run } from "./worker.js";

export function handle(request) {
  return run(request.body);
}
