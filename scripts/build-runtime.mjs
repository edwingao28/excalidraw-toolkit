// Build-time only. Consumers execute these bundles without the upstream package.
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import { createRequire, isBuiltin } from 'node:module';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const require = createRequire(import.meta.url);
const upstream = dirname(dirname(require.resolve('mcp-excalidraw-server')));
const pkg = JSON.parse(readFileSync(join(upstream, 'package.json'), 'utf8'));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const dist = join(upstream, 'dist');
const sourceFiles = Object.fromEntries(readdirSync(dist, { recursive: true }).filter(path => path.endsWith('.js')).sort().map(path => [path.replaceAll('\\', '/'), hash(readFileSync(join(dist, path)))]));
const sourceDigest = hash(JSON.stringify(sourceFiles));
const PINNED_DIST_SHA256 = 'c04eec947302a1d32a9485aa2cf7132f58a5bd223bd91febe17b59aff8c136eb';
if (pkg.version !== '2.0.0' || sourceDigest !== PINNED_DIST_SHA256) throw new Error('BACKEND_SOURCE: pinned upstream dist/version mismatch; review source before updating');
if (!existsSync(join(root, 'dist/canvas/index.html'))) throw new Error('CANVAS_ASSETS: build the pinned canvas first');

function replaceOnce(source, before, after) {
  if (source.split(before).length !== 2) throw new Error(`BACKEND_SOURCE: unexpected transform match count for ${before}`);
  return source.replace(before, after);
}
const output = join(root, 'dist/runtime');
rmSync(output, { recursive: true, force: true });
mkdirSync(output, { recursive: true });
const transformed = {
  name: 'pinned-upstream-paths',
  setup(builder) {
    builder.onLoad({ filter: /\.js$/ }, args => {
      if (!args.path.startsWith(dist + '/')) return;
      const path = relative(dist, args.path).replaceAll('\\', '/');
      let source = readFileSync(args.path, 'utf8');
      if (path === 'server.js') {
        for (const [before, after] of [
          ["const staticDir = path.join(__dirname, '../dist');", "const staticDir = fileURLToPath(new URL('../canvas', import.meta.url));"],
          ["app.use(express.static(path.join(__dirname, '../dist/frontend')));", '// The bundled canvas is served by staticDir.'],
          ["app.use('/assets/fonts', express.static(path.join(__dirname, '../node_modules/@excalidraw/excalidraw/dist/prod/fonts')));", "app.use('/assets/fonts', express.static(fileURLToPath(new URL('./fonts', import.meta.url))));"],
          ["const htmlFile = path.join(__dirname, '../dist/frontend/index.html');", "const htmlFile = path.join(staticDir, 'index.html');"],
        ]) source = replaceOnce(source, before, after);
      } else if (path === 'core/version.js') source = "export function packageVersion() { return '2.0.0'; }\n";
      else if (path === 'core/spawn.js') source = replaceOnce(source, "new URL('../server.js', import.meta.url)", "new URL('./server.mjs', import.meta.url)");
      else if (path === 'index.js') source = replaceOnce(source, 'if (isMainModule(import.meta.url)) {', 'if (false) { // bin.mjs explicitly starts the MCP server once.');
      return { contents: source, loader: 'js', resolveDir: dirname(args.path) };
    });
  },
};
const result = await build({
  entryPoints: { bin: join(dist, 'bin.js'), server: join(dist, 'server.js') },
  outdir: output, outExtension: { '.js': '.mjs' }, absWorkingDir: root,
  bundle: true, platform: 'node', format: 'esm', target: 'node20', metafile: true,
  plugins: [transformed], legalComments: 'external',
  banner: { js: "import { createRequire as __toolkitCreateRequire } from 'node:module'; const require = __toolkitCreateRequire(import.meta.url);" },
  external: ['bufferutil', 'utf-8-validate'],
});
for (const built of Object.values(result.metafile.outputs)) {
  for (const imported of built.imports) if (imported.external && !isBuiltin(imported.path) && !['bufferutil', 'utf-8-validate'].includes(imported.path)) throw new Error(`BACKEND_EXTERNAL: unexpected runtime dependency ${imported.path}`);
}
const fontRoot = join(dirname(createRequire(join(upstream, 'package.json')).resolve('@excalidraw/excalidraw')), 'fonts');
cpSync(fontRoot, join(output, 'fonts'), { recursive: true });
cpSync(join(upstream, 'LICENSE'), join(output, 'UPSTREAM-LICENSE'));

// Keep full license files for every package whose code actually enters a bundle.
const packages = new Map();
for (const input of Object.keys(result.metafile.inputs)) {
  let directory = dirname(resolve(root, input));
  while (directory !== dirname(directory)) {
    const manifest = join(directory, 'package.json');
    if (existsSync(manifest)) {
      const dependency = JSON.parse(readFileSync(manifest, 'utf8'));
      if (dependency.name && dependency.version) {
        const key = `${dependency.name}@${dependency.version}`;
        if (!packages.has(key)) {
          let licenses = readdirSync(directory).filter(name => /^(licen[cs]e|copying|notice)([.-]|$)/i.test(name) && statSync(join(directory, name)).isFile());
          if (!licenses.length) licenses = readdirSync(directory).filter(name => /^readme([.-]|$)/i.test(name) && /Copyright[\s\S]*Permission is hereby granted/i.test(readFileSync(join(directory, name), 'utf8')));
          if (!licenses.length) throw new Error(`BACKEND_LICENSE: no license file for ${key}`);
          packages.set(key, { name: dependency.name, version: dependency.version, license: dependency.license ?? null,
            notices: licenses.map(name => `${name}\n${readFileSync(join(directory, name), 'utf8')}`).join('\n\n') });
        }
        break;
      }
    }
    directory = dirname(directory);
  }
}
writeFileSync(join(output, 'THIRD_PARTY_NOTICES.txt'), [...packages.entries()].sort().map(([key, value]) => `${key}\n${'='.repeat(key.length)}\n${value.notices}`).join('\n\n'));
const files = Object.fromEntries(readdirSync(output, { recursive: true }).sort().filter(path => statSync(join(output, path)).isFile()).map(path => [path.replaceAll('\\', '/'), hash(readFileSync(join(output, path)))]));
const manifest = {
  schemaVersion: 1, upstream: { name: pkg.name, version: pkg.version, distSha256: sourceDigest, sourceFiles },
  build: { node: process.version, esbuild: JSON.parse(readFileSync(require.resolve('esbuild/package.json'), 'utf8')).version },
  entries: { mcp: 'bin.mjs', server: 'server.mjs' }, optionalNativeAccelerators: ['bufferutil', 'utf-8-validate'],
  packages: [...packages.values()].map(({ notices, ...dependency }) => dependency).sort((a, b) => a.name.localeCompare(b.name)), files,
};
writeFileSync(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Runtime: ${packages.size} bundled packages; upstream ${pkg.version}; source SHA256 ${sourceDigest}`);
