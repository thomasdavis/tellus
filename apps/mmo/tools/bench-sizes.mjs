import { RasterTarget, Screen, diffToAnsi, fbSize } from '@tellus/engine';
import { World } from '../src/world/world.js';
import { WorldRenderer } from '../src/render/renderer.js';
const world = new World(); const p = world.join('B'); const r = new WorldRenderer(world);
for (const [cols, rows] of [[150,46],[200,60],[240,70],[280,84]]) {
  const [fbW,fbH]=fbSize('octant',cols,rows);
  const target=new RasterTarget(fbW,fbH), cur=new Screen(cols,rows), prev=new Screen(cols,rows);
  const eye=[-6.5,world.groundAt(0,0)+4.2,-11], look=[3,world.groundAt(0,0)+1.1,12];
  r.render(target,world,p.id,eye,look,cols,rows); cur.setFromFramebuffer(target.rgb,fbW,fbH,'octant',12); diffToAnsi(cur,prev,true);
  const N=40; let tr=0,tf=0,td=0;
  for(let i=0;i<N;i++){let a=performance.now();r.render(target,world,p.id,eye,look,cols,rows);let b=performance.now();tr+=b-a;
    cur.setFromFramebuffer(target.rgb,fbW,fbH,'octant',12);let c=performance.now();tf+=c-b;diffToAnsi(cur,prev,false);td+=performance.now()-c;world.tick(0.033);}
  const tot=(tr+tf+td)/N;
  console.log(`${cols}x${rows} (fb ${fbW}x${fbH}): render ${(tr/N).toFixed(1)} fit ${(tf/N).toFixed(1)} diff ${(td/N).toFixed(1)} = ${tot.toFixed(1)}ms (${(1000/tot).toFixed(0)}fps)`);
}
