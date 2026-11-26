import {build} from 'esbuild';
import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
await build({entryPoints:{app:'web/team.tsx','report-fonts':'web/report-fonts.css'},bundle:true,outdir:'dist',format:'esm',target:'es2022',jsx:'automatic',minify:true,loader:{'.woff2':'dataurl','.png':'dataurl'},define:{'process.env.NODE_ENV':'"production"'}});
await copyFile('web/index.html','dist/index.html');
