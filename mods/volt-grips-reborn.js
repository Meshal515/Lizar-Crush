/*
  LIZAR CRUSH trap mod: Volt Grips Reborn
  ---------------------------------------
  Two gummy wall creatures live in sockets on the walls. Each has one big eye and a row of
  rubbery arms ending in glove hands. On their beat they unfold the arms, their fingertips
  charge, and then the hands hold the line with live current arcing across the middle.
  Touch an arm or the current and they catch the card, squeeze it, and fling it straight up.

  Cycle (one loop = Rest + Warn + Grip + Retract, Phase shifts it):
    rest     arms tucked, sleepy eye                         (safe)
    warn     arms unfold, fingertips charge, eye wide        (safe, the tell)
    grip     arms out straight, current on                   (DANGER: exactly what is drawn)
    retract  arms fold back                                  (safe)

  Hit area = the drawn arms (wall to fingertips) and the drawn current, radius Hit Thickness/2.
  Nothing outside the drawing can catch you.
  Catch = a slingshot: it tugs the card down, drags it further down (Pull Down), then flings it
  to exactly Fling Height above the point where it caught you, eased over Fling Time. It never kills.

  Install: Editor -> Import Mod -> paste this whole file.
*/

const VG_E = ["#f4feff", "#9ff0ff", "#2aa8ff"];   // electric palette of the original trap family
let vgFx = null;                                    // the one live catch (shared by every copy)
let vgPal = null;
const vgBx = [], vgBy = [];

const vgClamp = (v, lo, hi) => { return Math.max(lo, Math.min(hi, v)); }
const vgNum = (v, d, lo, hi) => { v = Number(v); if(!Number.isFinite(v)) v = d; return vgClamp(v, lo, hi); }
const vgSm = (u) => { u = vgClamp(u, 0, 1); return u*u*(3 - 2*u); }
const vgOut3 = (u) => { u = vgClamp(u, 0, 1); return 1 - Math.pow(1 - u, 3); }
const vgHash = (n) => { const x = Math.sin(n*12.9898 + 78.233)*43758.5453; return x - Math.floor(x); }

const vgCfg = (o) => {
  const side = (o.side === "left" || o.side === "right") ? o.side : "both";
  const c = {
    side,
    y: Number(o.y) || 700,
    height: vgNum(o.height, 170, 40, 520),
    fingers: Math.round(vgNum(o.fingers, 4, 1, 10)),
    gap: vgNum(o.gap, 34, 12, 120),
    reach: vgNum(o.reach, 90, 30, 300),
    restTime: vgNum(o.restTime, 1.45, .1, 8),
    warnTime: vgNum(o.warnTime, .4, .15, 2),
    activeTime: vgNum(o.activeTime, 1.1, .1, 8),
    retractTime: .28,
    grabTime: vgNum(o.grabTime, .18, .06, 1),
    squeezeTime: vgNum(o.squeezeTime, .3, .05, 2),
    pullDown: vgNum(o.pullDown, 46, 0, 300),
    flingHeight: vgNum(o.flingHeight, 140, 0, 4000),
    flingTime: vgNum(o.flingTime, .45, .12, 3),
    hitThickness: vgNum(o.hitThickness, 12, 4, 40),
    cooldown: vgNum(o.cooldown, .5, 0, 5),
    sparkPower: vgNum(o.sparkPower, 1, 0, 3),
    showZone: o.showZone !== false
  };
  c.zTop = c.y - c.height/2;
  c.cycle = c.restTime + c.warnTime + c.activeTime + c.retractTime;
  return c;
}

// Where in its loop the trap is. ext = how far the arms are out (0 tucked .. 1 full), smooth.
const vgPhase = (c, t) => {
  const local = ((t % c.cycle) + c.cycle) % c.cycle;
  const st = {local, name:"rest", u:0, ext:0, live:false, charge:0};
  let x = local;
  if(x < c.restTime){ st.name = "rest"; st.u = x/c.restTime; return st; }
  x -= c.restTime;
  if(x < c.warnTime){ st.name = "warn"; st.u = x/c.warnTime; st.ext = vgSm(st.u); st.charge = vgSm(st.u); return st; }
  x -= c.warnTime;
  if(x < c.activeTime){ st.name = "grip"; st.u = x/c.activeTime; st.ext = 1; st.live = true; st.charge = 1; return st; }
  x -= c.activeTime;
  st.name = "retract"; st.u = x/c.retractTime; st.ext = 1 - vgSm(st.u); st.charge = 1 - vgSm(st.u*2.5);
  return st;
}

const vgRowY = (c, i) => { return c.zTop + c.height*(i + 1)/(c.fingers + 1); }
const vgTips = (c, W) => {
  const t = {left:c.reach, right:W - c.reach};
  if(c.side === "both"){ t.left = W/2 - c.gap; t.right = W/2 + c.gap; }
  return t;
}
const vgOverlap = (a, b) => { return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y; }

// Exactly the drawn danger: arms (wall to fingertips) + the current across the middle.
const vgHits = (c, rect, W, cap) => {
  const r = c.hitThickness*.45;
  const zone = {x:0, y:c.zTop - r, w:W, h:c.height + r*2};
  if(!vgOverlap(rect, zone)) return false;
  const tips = vgTips(c, W);
  for(let i=0;i<c.fingers;i++){
    const y = vgRowY(c, i);
    if(c.side !== "right" && cap({x:0, y}, {x:tips.left, y}, r, rect)) return true;
    if(c.side !== "left" && cap({x:tips.right, y}, {x:W, y}, r, rect)) return true;
    if(c.side === "both" && cap({x:tips.left, y}, {x:tips.right, y}, r*.8, rect)) return true;
  }
  return false;
}

const vgStale = (api) => { return !vgFx || api.time < vgFx.lastStep - .01 || api.time - vgFx.lastStep > .25; }

const vgStartCatch = (trap, c, api, rect) => {
  vgFx = {trap, side:c.side, phase:"catch", t0:api.time, lastStep:api.time, startY:api.player.baseY, catchY:api.player.baseY, cx:rect.x + rect.w/2, cy:rect.y + rect.h/2};
  api.state.set("lock", api.time + c.grabTime + c.squeezeTime + c.flingTime + c.cooldown + c.retractTime);
  api.effects.shake(1.6);
  api.effects.particles(rect.x + rect.w/2, rect.y + rect.h*.5, Math.round(8*c.sparkPower) + 2, VG_E[1], {speed:120, spread:rect.w*.8, life:.3, size:2.4});
}

const vgRunCatch = (c, api, dt) => {
  const fx = vgFx, P = api.player;
  fx.lastStep = api.time;
  P.freeze(.06);                                         // no stretching while held
  const h = P.h + (P.normalH - P.h)*Math.min(1, dt*18);  // a stretched card snaps back to normal
  let baseY = P.baseY;
  const e = api.time - fx.t0;
  // slingshot: the catch tugs the card down a little, the squeeze drags it further down, then it flies
  if(fx.phase === "catch"){
    baseY = fx.catchY + c.pullDown*.35*vgSm(e/c.grabTime);
    if(e >= c.grabTime){ fx.phase = "squeeze"; fx.t0 += c.grabTime; }
  }
  else if(fx.phase === "squeeze" && e < c.squeezeTime) baseY = fx.catchY + c.pullDown*(.35 + .65*vgSm(e/c.squeezeTime));
  else if(fx.phase === "squeeze"){
    baseY = fx.catchY + c.pullDown;
    fx.phase = "fling"; fx.t0 += c.squeezeTime; fx.startY = baseY;
    api.effects.shake(4.5 + c.sparkPower);
    api.effects.particles(P.centerX, P.y + P.h, Math.round(14*c.sparkPower) + 4, VG_E[1], {speed:160, spread:P.w, life:.35, size:2.8});
  } else if(fx.phase === "fling"){
    const p = Math.min(1, e/c.flingTime);
    const target = fx.catchY - c.flingHeight;
    baseY = fx.startY + (target - fx.startY)*vgOut3(p);
    if(p >= 1){ api.state.set("relT", api.time); vgFx = null; }
  }
  P.teleport(P.x, baseY, {h, camera:false});             // also cancels any release animation
}

// ---------------- drawing ----------------
const vgRgb = (hex) => {
  let h = String(hex || "").trim().replace("#", "");
  if(h.length === 3) h = h.split("").map(ch => ch + ch).join("");
  if(!/^[0-9a-fA-F]{6}$/.test(h)) h = "ff3fae";
  const n = parseInt(h, 16);
  const out = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  return out;
}
const vgMix = (a, b, t, al) => {
  const r = Math.round(a[0] + (b[0] - a[0])*t), g = Math.round(a[1] + (b[1] - a[1])*t), bl = Math.round(a[2] + (b[2] - a[2])*t);
  return al == null ? "rgb(" + r + "," + g + "," + bl + ")" : "rgba(" + r + "," + g + "," + bl + "," + al + ")";
}
const vgPalette = (api) => {
  const key = api.colors.main + "|" + api.colors.accent;
  if(vgPal && vgPal.key === key) return vgPal;
  const M = vgRgb(api.colors.main), K = [0,0,0], Wt = [255,255,255];
  const pal = {
    key,
    main: vgMix(M, M, 0),
    dark: vgMix(M, K, .28),
    deep: vgMix(M, K, .5),
    ink: vgMix(M, K, .72),
    light: vgMix(M, Wt, .45),
    belly: vgMix(M, Wt, .32, .55),
    shadow: vgMix(M, K, .55, .22)
  };
  vgPal = pal;
  return pal;
}

const vgBolt = (ctx, ax, ay, bx, by, amp, steps, seed, w, alpha) => {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, nx = -dy/len, ny = dx/len;
  for(let i=0;i<=steps;i++){
    const u = i/steps, off = (i === 0 || i === steps) ? 0 : (vgHash(seed + i*7.31) - .5)*2*amp*Math.sin(u*Math.PI);
    vgBx[i] = ax + dx*u + nx*off; vgBy[i] = ay + dy*u + ny*off;
  }
  ctx.beginPath(); ctx.moveTo(vgBx[0], vgBy[0]);
  for(let i=1;i<=steps;i++) ctx.lineTo(vgBx[i], vgBy[i]);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.strokeStyle = VG_E[2];
  ctx.globalAlpha = .2*alpha; ctx.lineWidth = w*4.2; ctx.stroke();
  ctx.globalAlpha = .9*alpha; ctx.lineWidth = w*1.6; ctx.stroke();
  ctx.strokeStyle = VG_E[1]; ctx.globalAlpha = alpha; ctx.lineWidth = w*.95; ctx.stroke();
  ctx.strokeStyle = VG_E[0]; ctx.lineWidth = Math.max(.8, w*.42); ctx.stroke();
  ctx.globalAlpha = 1;
}

// Glove hand in a local frame: +x points away from the wrist. curl 0 = spread, 1 = fist.
const vgHand = (ctx, x, y, ang, d, s, curl, pal, glow, big) => {
  ctx.save();
  ctx.translate(x, y); ctx.scale(d, 1); ctx.rotate(ang);
  const k = s*big;
  // fingers + thumb as one path, drawn dark (underside) then main
  ctx.beginPath();
  for(let f=-1;f<=1;f++){
    const bx = 7*k, by = f*3.3*k;
    const a0 = f*(.34 - .24*curl), a1 = a0 + curl*1.35, a2 = a0 + curl*2.6;
    const px = bx + Math.cos(a1)*4.4*k, py = by + Math.sin(a1)*4.4*k;
    ctx.moveTo(bx, by); ctx.lineTo(px, py); ctx.lineTo(px + Math.cos(a2)*3.8*k, py + Math.sin(a2)*3.8*k);
  }
  const ta = -1.05 + curl*.85;
  ctx.moveTo(3.5*k, -3.6*k); ctx.lineTo(3.5*k + Math.cos(ta)*5*k, -3.6*k + Math.sin(ta)*5*k);
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  ctx.save(); ctx.translate(0, 1.1*k); ctx.strokeStyle = pal.dark; ctx.lineWidth = 3.9*k; ctx.stroke(); ctx.restore();
  ctx.strokeStyle = pal.main; ctx.lineWidth = 3.5*k; ctx.stroke();
  // palm
  ctx.fillStyle = pal.dark;
  ctx.beginPath(); ctx.ellipse(3.6*k, 1.1*k, 6.2*k, 5.5*k, 0, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = pal.main;
  ctx.beginPath(); ctx.ellipse(3.6*k, 0, 6.2*k, 5.4*k, 0, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,.34)";
  ctx.beginPath(); ctx.ellipse(2.6*k, -2.3*k, 3*k, 1.6*k, -.2, 0, Math.PI*2); ctx.fill();
  // glove cuff
  ctx.fillStyle = pal.light;
  ctx.beginPath(); ctx.ellipse(-2*k, 0, 2.2*k, 4.8*k, 0, 0, Math.PI*2); ctx.fill();
  // charged fingertips
  if(glow > .01){
    for(let f=-1;f<=1;f++){
      const a0 = f*(.34 - .24*curl), a1 = a0 + curl*1.35, a2 = a0 + curl*2.6;
      const px = 7*k + Math.cos(a1)*4.4*k + Math.cos(a2)*3.8*k, py = f*3.3*k + Math.sin(a1)*4.4*k + Math.sin(a2)*3.8*k;
      ctx.globalAlpha = .35*glow; ctx.fillStyle = VG_E[2];
      ctx.beginPath(); ctx.arc(px, py, 3.6*k, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = glow; ctx.fillStyle = VG_E[0];
      ctx.beginPath(); ctx.arc(px, py, 1.5*k, 0, Math.PI*2); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
  ctx.restore();
}

// One almond eye, drawn in the creature's local frame (+x = toward the middle).
// Lids are skin: painted with skin() so they carry the exact body shading. No clip().
const vgEye = (ctx, x, y, rx, ry, open, squint, slant, lookX, lookY, pal, s, skin) => {
  ctx.fillStyle = "#fffaf4";
  ctx.beginPath(); ctx.ellipse(x, y, rx, ry, 0, 0, Math.PI*2); ctx.fill();
  const ix = x + lookX*rx*.3, iy = y + lookY*ry*.26;
  ctx.fillStyle = pal.deep; ctx.beginPath(); ctx.arc(ix, iy, rx*.56, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "#16070f"; ctx.beginPath(); ctx.arc(ix, iy, rx*.3, 0, Math.PI*2); ctx.fill();
  ctx.fillStyle = "#ffffff"; ctx.beginPath(); ctx.arc(ix - rx*.2, iy - ry*.22, rx*.14, 0, Math.PI*2); ctx.fill();
  const m = 1.2*s, RX = rx + m, RY = ry + m;
  // upper lid: follows the eyeball's own outline; inner corner (+x) drops when angry (slant > 0)
  const lidY = y - ry + 2*ry*(1 - open);
  const inY = Math.min(y + ry*.98, lidY + slant*ry*.42), outY = Math.min(y + ry*.98, lidY - slant*ry*.42);
  const midY = vgClamp((inY + outY)/2 + ry*(.32 - .6*open), y - RY, y + RY);
  const angIn = Math.asin(vgClamp((inY - y)/RY, -1, 1)), angOut = Math.PI - Math.asin(vgClamp((outY - y)/RY, -1, 1));
  ctx.beginPath();
  ctx.ellipse(x, y, RX, RY, 0, angOut, angIn + Math.PI*2, false);
  ctx.quadraticCurveTo(x, midY, x + Math.cos(angOut)*RX, outY);
  ctx.closePath(); skin();
  // lower lid
  if(squint > .01){
    const loY = y + ry - 2*ry*squint*.55;
    const a1 = Math.asin(vgClamp((loY - y)/RY, -1, 1));
    ctx.beginPath();
    ctx.ellipse(x, y, RX, RY, 0, a1, Math.PI - a1, false);
    ctx.quadraticCurveTo(x, loY - ry*.2, x + Math.cos(a1)*RX, loY);
    ctx.closePath(); skin();
  }
  // lash line + soft socket rim
  ctx.strokeStyle = pal.ink; ctx.lineWidth = Math.max(1, 1.8*s); ctx.lineCap = "round";
  ctx.beginPath(); ctx.moveTo(x + Math.cos(angIn)*RX, inY); ctx.quadraticCurveTo(x, midY, x + Math.cos(angOut)*RX, outY); ctx.stroke();
  ctx.strokeStyle = pal.shadow; ctx.lineWidth = Math.max(1, 1.3*s);
  ctx.beginPath(); ctx.ellipse(x, y, RX, RY, 0, 0, Math.PI*2); ctx.stroke();
}

const vgDrawSide = (ctx, api, c, d, wallX, ph, info, s, pal) => {
  const now = api.time;
  const yT = api.screen(0, c.zTop - 26).y, yB = api.screen(0, c.zTop + c.height + 8).y;
  const L = Math.max(46*s, yB - yT);
  const breath = 1 + .03*Math.sin(now*2.6 + (d > 0 ? 0 : 1.3));
  const kick = info.strain, stretch = info.joyKick;
  const sx = breath*(1 - .08*kick + .12*stretch), sy = 1 + .05*kick - .04*stretch;
  const quiver = kick*Math.sin(now*46)*1.1*s;
  const hR = Math.min(21*s, L*.24);               // head radius
  const hx = hR*.98, hy = yT + hR;                // head centre (local x)
  const bodyOut = 33*s;                           // torso bulge
  const neckY = hy + hR*1.05;
  const armRootX = bodyOut*.45*sx;

  // arms first: they come out from inside the torso
  const rows = info.hands;
  const aw = Math.max(2, c.hitThickness*.75*s);
  for(let i=0;i<rows.length;i++){
    const hd = rows[i];
    const rx = wallX + d*armRootX, ry = hd.rowY;
    const dx = hd.wx - rx, lift = hd.lift;
    const c1x = rx + dx*.35, c1y = ry - lift, c2x = rx + dx*.72, c2y = hd.wy - lift*.35;
    hd.c2x = c2x; hd.c2y = c2y;
    ctx.lineCap = "round";
    ctx.beginPath(); ctx.moveTo(rx, ry); ctx.bezierCurveTo(c1x, c1y, c2x, c2y, hd.wx, hd.wy);
    ctx.strokeStyle = pal.dark; ctx.lineWidth = aw; ctx.stroke();
    ctx.save(); ctx.translate(0, -aw*.14);
    ctx.strokeStyle = pal.main; ctx.lineWidth = aw*.66; ctx.stroke();
    ctx.translate(0, -aw*.16);
    ctx.strokeStyle = "rgba(255,255,255,.3)"; ctx.lineWidth = aw*.2; ctx.stroke();
    ctx.restore();
    if(info.charge > .02){                          // current crawling out along the arm
      const u = ((now*1.7 + i*.31 + (d > 0 ? 0 : .5)) % 1), iu = 1 - u;
      const px = iu*iu*iu*rx + 3*iu*iu*u*c1x + 3*iu*u*u*c2x + u*u*u*hd.wx;
      const py = iu*iu*iu*ry + 3*iu*iu*u*c1y + 3*iu*u*u*c2y + u*u*u*hd.wy;
      ctx.globalAlpha = .4*info.charge; ctx.fillStyle = VG_E[2];
      ctx.beginPath(); ctx.arc(px, py, aw*.75, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = info.charge; ctx.fillStyle = VG_E[0];
      ctx.beginPath(); ctx.arc(px, py, aw*.28, 0, Math.PI*2); ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  // body + head in the local frame: x grows toward the middle, squash/stretch from the wall/feet
  ctx.save();
  ctx.translate(wallX + d*quiver, yB); ctx.scale(d*sx, sy); ctx.translate(0, -yB);
  // socket plate on the wall, peeking above and below
  ctx.fillStyle = pal.deep;
  ctx.beginPath(); ctx.ellipse(0, (neckY + yB)/2, 7*s, (yB - neckY)/2 + 6*s, 0, 0, Math.PI*2); ctx.fill();
  const path = () => {
    ctx.beginPath();
    ctx.moveTo(-4*s, hy - hR*.86);
    ctx.ellipse(hx, hy, hR, hR, 0, -2.6, 1.2, false);                 // over the head, down its inner side
    ctx.bezierCurveTo(hx + hR*.2, neckY + hR*.15, bodyOut, neckY + hR*.2, bodyOut, neckY + (yB - neckY)*.38);
    ctx.bezierCurveTo(bodyOut, yB - (yB - neckY)*.2, bodyOut*.9, yB - 6*s, bodyOut*.55, yB - 1*s);
    ctx.quadraticCurveTo(bodyOut*.25, yB + 3*s, -4*s, yB);
    ctx.closePath();
  };
  const g = ctx.createRadialGradient(hx + hR*.15, hy - hR*.45, 1.5*s, hx*.7, hy + hR*.6, L*.92);
  g.addColorStop(0, "rgba(255,255,255,.46)"); g.addColorStop(.12, "rgba(255,255,255,.12)");
  g.addColorStop(.3, "rgba(255,255,255,0)"); g.addColorStop(1, "rgba(0,0,0,.26)");
  const skin = () => { ctx.fillStyle = pal.main; ctx.fill(); ctx.fillStyle = g; ctx.fill(); };
  ctx.save(); ctx.translate(3*s, 4*s); path(); ctx.fillStyle = pal.shadow; ctx.fill(); ctx.restore();
  path(); skin();
  // soft belly: a lighter oval on the torso
  const bellyY = neckY + (yB - neckY)*.52, bellyH = (yB - neckY)*.34;
  ctx.fillStyle = pal.belly;
  ctx.beginPath(); ctx.ellipse(bodyOut*.6, bellyY, bodyOut*.26, Math.min(bellyH, 34*s), 0, 0, Math.PI*2); ctx.fill();
  // under-chin shadow, sells the head sitting on the torso
  ctx.strokeStyle = pal.shadow; ctx.lineWidth = Math.max(1, 2.2*s);
  ctx.beginPath(); ctx.ellipse(hx, hy, hR*.97, hR*.97, 0, .55, 1.25, false); ctx.stroke();

  // eye + brow
  const ex = hx + hR*.22, ey = hy + hR*.06, erx = hR*.5, ery = hR*.56;
  vgEye(ctx, ex, ey, erx, ery, info.open, info.squint, info.slant, info.lookX, info.lookY, pal, s, skin);
  ctx.strokeStyle = pal.dark; ctx.lineWidth = Math.max(1.5, 3.4*s); ctx.lineCap = "round";
  const bY = ey - ery - 5*s - info.browUp*4*s;
  ctx.beginPath(); ctx.moveTo(ex - erx*.85, bY - info.slant*2.5*s); ctx.quadraticCurveTo(ex, bY - 2.5*s*(1 - Math.max(0, info.slant)) + info.slant*.5*s, ex + erx*.9, bY + info.slant*5*s); ctx.stroke();
  ctx.restore();

  // hands on top (a tucked fist rests in front of the body)
  for(const hd of rows){
    const ang = Math.atan2(hd.wy - hd.c2y, (hd.wx - hd.c2x)*d || .001);
    vgHand(ctx, hd.wx, hd.wy, vgClamp(ang, -1.1, 1.1), d, s, hd.curl, pal, hd.glow, 1.25);
  }
}

const mod = {
  id: "volt_grips_reborn",
  name: "Volt Grips Reborn",
  help: "Wall creatures hold the line with live hands, catch the card and fling it straight up.",
  defaults: {
    side:"both", height:170, fingers:4, gap:34, reach:90,
    restTime:1.45, warnTime:.4, activeTime:1.1,
    grabTime:.18, squeezeTime:.3, pullDown:46, flingHeight:140, flingTime:.45,
    hitThickness:12, cooldown:.5, sparkPower:1, showZone:true
  },
  settings: [
    {key:"side", label:"Side", type:"select", options:["both","left","right"], default:"both"},
    {key:"height", label:"Zone Height", type:"number", default:170, step:5, min:40, max:520},
    {key:"fingers", label:"Arms", type:"number", default:4, step:1, min:1, max:10},
    {key:"gap", label:"Middle Gap (both)", type:"number", default:34, step:1, min:12, max:120},
    {key:"reach", label:"Reach (one side)", type:"number", default:90, step:5, min:30, max:300},
    {key:"restTime", label:"Rest Time (s)", type:"number", default:1.45, step:.05, min:.1, max:8},
    {key:"warnTime", label:"Warning Time (s)", type:"number", default:.4, step:.05, min:.15, max:2},
    {key:"activeTime", label:"Grip Time (s)", type:"number", default:1.1, step:.05, min:.1, max:8},
    {key:"grabTime", label:"Catch Time (s)", type:"number", default:.18, step:.01, min:.06, max:1},
    {key:"squeezeTime", label:"Squeeze Time (s)", type:"number", default:.3, step:.01, min:.05, max:2},
    {key:"pullDown", label:"Pull Down (before fling)", type:"number", default:46, step:2, min:0, max:300},
    {key:"flingHeight", label:"Fling Height", type:"number", default:140, step:10, min:0, max:4000},
    {key:"flingTime", label:"Fling Time (s)", type:"number", default:.45, step:.05, min:.12, max:3},
    {key:"hitThickness", label:"Arm Thickness (hit)", type:"number", default:12, step:1, min:4, max:40},
    {key:"cooldown", label:"Cooldown (s)", type:"number", default:.5, step:.05, min:0, max:5},
    {key:"sparkPower", label:"Spark Power", type:"number", default:1, step:.1, min:0, max:3},
    {key:"showZone", label:"Show Zone (editor)", type:"checkbox", default:true}
  ],

  bounds(trap, api){
    const c = vgCfg(trap), W = api.WORLD_W;
    const b = {x:0, y:c.zTop - 40, w:W, h:c.height + 80};
    if(c.side === "left") b.w = c.reach + 40;
    if(c.side === "right"){ b.x = W - c.reach - 40; b.w = c.reach + 40; }
    return b;
  },

  update(trap, api, dt){
    const c = vgCfg(trap);
    if(vgFx && vgFx.trap === trap){
      if(vgStale(api)) vgFx = null;
      else vgRunCatch(c, api, dt);
    }
  },

  // Catching happens here (swept player box, every step). It never kills.
  collide(trap, rect, api){
    if(vgFx && !vgStale(api)) return false;
    vgFx = null;
    const c = vgCfg(trap);
    if(!vgPhase(c, api.trapTime).live) return false;
    if(Number(api.state.get("lock", 0)) > api.time) return false;
    if(vgHits(c, rect, api.WORLD_W, api.collision.capsuleRectCollide)) vgStartCatch(trap, c, api, rect);
    return false;
  },

  draw(trap, api){
    const ctx = api.ctx, c = vgCfg(trap), W = api.WORLD_W, now = api.time;
    const editor = api.gameState === "editor";
    const pal = vgPalette(api);
    const s = api.screen(0, 0).s;
    let ph = vgPhase(c, api.trapTime);
    if(editor) ph = {name:"grip", u:.5, ext:1, live:true, charge:1};
    const tips = vgTips(c, W);
    const pr = api.player;                               // x = center, y = top
    const fx = (vgFx && vgFx.trap === trap) ? vgFx : null;

    // catch blend: hands leave the line and close on the card, then let go when it flies
    let cap = 0, curlGrip = 0, strain = 0, joy = 0, joyKick = 0;
    if(fx){
      const e = now - fx.t0;
      if(fx.phase === "catch"){ const u = vgOut3(e/c.grabTime); cap = u; curlGrip = u; }
      else if(fx.phase === "squeeze"){ cap = 1; curlGrip = 1; strain = vgSm(e/(c.squeezeTime*.4)); }
      else { const u = e/c.flingTime; cap = 1 - vgSm(u/.45); curlGrip = 1 - vgSm(u/.2); strain = 1 - vgSm(u/.15); joy = vgSm(u/.15); joyKick = Math.sin(vgClamp(u/.5, 0, 1)*Math.PI); }
    } else {
      const rel = now - Number(api.state.get("relT", -99));
      if(rel >= 0 && rel < .6) joy = 1 - vgSm(rel/.6);
    }

    // mood
    const zoneTop = c.zTop;
    const passed = editor ? 0 : vgSm((zoneTop - 12 - pr.baseY)/50);
    const tell = ph.name === "warn" ? vgSm(ph.u*1.6) : (ph.live ? 1 : (ph.name === "retract" ? 1 - vgSm(ph.u) : 0));
    let open = .42 + .53*tell, slant = .1 + .45*tell, squint = 0, browUp = ph.name === "warn" ? Math.sin(ph.u*Math.PI) : 0;
    const hold = fx ? 1 : 0;
    open += (.85 - open)*hold; slant += (.95 - slant)*hold; squint += .38*strain;
    open += (.16 - open)*joy; squint += .62*joy; slant += (-.15 - slant)*joy;
    open += (.3 - open)*passed*(1 - hold); slant += (-.3 - slant)*passed*(1 - hold);
    const blinkP = 3.7, bph = (now + vgHash(trap.y || 1)*blinkP) % blinkP;
    if(bph < .16 && !fx) open *= 1 - .95*Math.sin(bph/.16*Math.PI);

    ctx.save();
    if(editor && c.showZone){
      const z0 = api.screen(0, c.zTop);
      ctx.fillStyle = vgMix(vgRgb(api.colors.main), vgRgb(api.colors.main), 0, .07);
      ctx.fillRect(z0.x, z0.y, W*s, c.height*s);
      ctx.strokeStyle = VG_E[2]; ctx.globalAlpha = .55; ctx.lineWidth = Math.max(1, 1.2*s); ctx.setLineDash([6*s, 5*s]);
      ctx.strokeRect(z0.x, z0.y, W*s, c.height*s); ctx.setLineDash([]); ctx.globalAlpha = 1;
    }
    const sides = c.side === "both" ? [1, -1] : [c.side === "left" ? 1 : -1];
    const gripPts = {};
    for(const d of sides){
      const wallX = api.screen(d > 0 ? 0 : W, 0).x;
      const tipX = api.screen(d > 0 ? tips.left : tips.right, 0).x;
      const hands = [];
      for(let i=0;i<c.fingers;i++){
        const rowY = api.screen(0, vgRowY(c, i)).y;
        const hl = 19*s;                                   // wrist -> fingertip length
        const sway = Math.sin(now*5.2 + i*1.4 + (d > 0 ? 0 : 2))*1.1*s;
        // live pose: fingertips exactly at the end of the hit line
        const liveX = tipX - d*hl, liveY = rowY + sway*ph.ext*.6;
        // tucked pose: a fist resting in front of the body
        const restX = wallX + d*44*s, restY = rowY + 5*s;
        let wx = restX + (liveX - restX)*ph.ext, wy = restY + (liveY - restY)*ph.ext;
        let lift = 3*s*ph.ext*Math.sin(now*3 + i) + (1 - ph.ext)*10*s;
        if(cap > 0){
          const cw = pr.w*s, chh = pr.h*s, cx0 = api.screen(pr.centerX, pr.y);
          const n = c.fingers;
          const gx = cx0.x - d*(cw/2 + 9*s), gy = cx0.y + chh*(n === 1 ? .5 : .2 + .6*i/(n - 1));
          wx += (gx - wx)*cap; wy += (gy - wy)*cap; lift += (6*s - lift)*cap;
        }
                const glow = Math.max(ph.charge, cap);
        hands.push({rowY, wx, wy, lift, curl: Math.max(1 - ph.ext, curlGrip*.85), glow});
        (gripPts[d] = gripPts[d] || []).push({x:wx + d*hl*(1 - cap*.4), y:wy});
      }
      vgDrawSide(ctx, api, c, d, wallX, ph, {hands, open: vgClamp(open, 0, 1), squint: vgClamp(squint, 0, 1), slant: vgClamp(slant, -1, 1),
        lookX: fx ? .4 : (passed > .5 ? .1 : .8), lookY: passed > .5 ? -.9 : (fx ? 0 : .25), browUp, strain, joyKick, charge: ph.charge}, s, pal);
    }
    // the current: full strength from the first live frame, across the exact hit line
    if(c.side === "both" && (ph.live || (fx && fx.phase !== "fling"))){
      const L = gripPts[1], R = gripPts[-1], tick = Math.floor(now*24);
      for(let i=0;i<c.fingers;i++){
        const a = L[i], b = R[i];
        const amp = (2.5 + 2*c.sparkPower + cap*6)*s;
        vgBolt(ctx, a.x, a.y, b.x, b.y, amp, 8, i*3.1 + tick*1.7, Math.max(1.4, 1.9*s), editor ? .55 : .95);
      }
    } else if(ph.live && c.sparkPower > 0){
      const tick = Math.floor(now*20);
      for(const d of sides) for(const t of gripPts[d]){
        vgBolt(ctx, t.x, t.y, t.x + d*(5 + 4*vgHash(tick + t.y))*s, t.y + (vgHash(tick*1.3 + t.y) - .5)*8*s, 1.5*s, 3, tick + t.y, Math.max(1, 1.1*s), .8);
      }
    }
    ctx.restore();
  }
};
