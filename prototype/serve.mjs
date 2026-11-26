import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';

const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/web/palette.css', ['../web/palette.css', 'text/css']],
  ['/dashboard.css', ['dashboard.css', 'text/css']],
  ['/dist/report-fonts.css', ['../dist/report-fonts.css', 'text/css']],
  ...['dashboard.js', 'metrics.js', 'data.js'].map(file=>['/'+file,[file,'text/javascript']])
]);
const port = Number(process.env.PORT || 8085);
const server = createServer(async (req,res)=>{
  const asset = assets.get(req.url.split('?')[0]);
  if (req.method !== 'GET' || !asset) { res.writeHead(404).end(); return; }
  try {
    const body = await readFile(new URL(asset[0], import.meta.url));
    res.writeHead(200, {'Content-Type':asset[1]+'; charset=utf-8','Cache-Control':'no-store'}).end(body);
  } catch {
    res.writeHead(500).end('File unavailable');
  }
});
server.listen(port, '127.0.0.1', ()=>console.log('http://127.0.0.1:'+port+'/'));
