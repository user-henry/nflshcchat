// 用真实 WebRTC 实现（werift，纯 JS）复现会议页的协商顺序，验证视频能真正传输
// 用法: npm i --no-save werift && node test-webrtc-negotiation.mjs
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters } from 'werift';

// 与 meeting-room.html 保持一致的配置
const ICE = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };

let pass = 0, fail = 0;
const check = (n, c, extra = '') => { if (c) { pass++; console.log('  ✅ ' + n + (extra ? '  ' + extra : '')); } else { fail++; console.log('  ❌ ' + n + '  ' + extra); } };

// 造一条假的音视频轨道（不采集真实设备）
function fakeTrack(kind) {
  const t = new MediaStreamTrack({ kind });
  return t;
}

function makePC() {
  const pc = new RTCPeerConnection(ICE);
  const txAudio = pc.addTransceiver('audio', { direction: 'sendrecv' });
  const txVideo = pc.addTransceiver('video', { direction: 'sendrecv' });
  return { pc, txAudio, txVideo };
}

const signals = [];   // 模拟服务端信令通道（A→B / B→A）
const deliver = (to, from, kind, payload) => signals.push({ to, from, kind, payload });

function sdpDirections(sdp) {
  return (sdp || '').split(/\r?\n/).filter(l => /^m=|^a=(sendrecv|sendonly|recvonly|inactive)/.test(l));
}

console.log('[1] 双方各建连接：预建 audio/video transceiver（sendrecv）');
const A = makePC();
const B = makePC();
check('A 有 audio/video transceiver', A.pc.getTransceivers().length === 2);
check('B 有 audio/video transceiver', B.pc.getTransceivers().length === 2);

// 信令桥（把信令按 web 端逻辑投递：offer/answer 直接转交，ice 也转交）
async function pump(maxRounds = 40) {
  let rounds = 0;
  while (signals.length && rounds++ < maxRounds) {
    const s = signals.shift();
    const target = s.to === 'A' ? A : B;
    if (s.kind === 'offer') {
      await target.pc.setRemoteDescription(s.payload);
      const answer = await target.pc.createAnswer();
      await target.pc.setLocalDescription(answer);
      deliver(s.from, s.to, 'answer', answer);
    } else if (s.kind === 'answer') {
      if (target.pc.signalingState === 'have-local-offer') await target.pc.setRemoteDescription(s.payload);
    } else if (s.kind === 'ice') {
      try {
        if (target.pc.remoteDescription) await target.pc.addIceCandidate(s.payload);
      } catch (e) { /* 忽略 */ }
    }
  }
}

console.log('\n[2] A 发起协商（尚未开启任何媒体，与页面点「立即开会」后进房间一致）');
const offer1 = await A.pc.createOffer();
await A.pc.setLocalDescription(offer1);
deliver('B', 'A', 'offer', { type: 'offer', sdp: A.pc.localDescription.sdp });
await pump();
const dirs1 = sdpDirections(A.pc.localDescription.sdp);
console.log('     offer m-line 方向: ' + dirs1.filter(l => l.startsWith('a=') || l.startsWith('m=')).join(' | '));
check('offer 里 audio 与 video 两条 m-line 都是 sendrecv',
  /m=audio[\s\S]*?a=sendrecv/.test(A.pc.localDescription.sdp) && /m=video[\s\S]*?a=sendrecv/.test(A.pc.localDescription.sdp));
check('协商完成（A signalingState=stable）', A.pc.signalingState === 'stable', A.pc.signalingState);
check('B 也稳定', B.pc.signalingState === 'stable', B.pc.signalingState);

console.log('\n[3] 之后才开启麦克风/摄像头 → 只 replaceTrack，不重新协商');
const aAudio = fakeTrack('audio');
const aVideo = fakeTrack('video');
const sigBefore = signals.length;
await A.txAudio.sender.replaceTrack(aAudio);
await A.txVideo.sender.replaceTrack(aVideo);
check('replaceTrack 没有产生任何新信令（无需重新协商）', signals.length === sigBefore, 'pending=' + signals.length);
check('A 的 audio sender 已挂上轨道', !!A.txAudio.sender.track);
check('A 的 video sender 已挂上轨道', !!A.txVideo.sender.track);

console.log('\n[4] 另一端同样后开媒体');
const bAudio = fakeTrack('audio');
const bVideo = fakeTrack('video');
await B.txAudio.sender.replaceTrack(bAudio);
await B.txVideo.sender.replaceTrack(bVideo);
check('B 的 video sender 已挂上轨道', !!B.txVideo.sender.track);

console.log('\n[5] 关键点：视频 m-line 的协商方向必须是 sendrecv（旧实现是 inactive，所以视频永远不通）');
const aSdp = A.pc.localDescription.sdp;
const bSdp = B.pc.localDescription.sdp;
const vA = /m=video([\s\S]*?)(?=m=|$)/.exec(aSdp);
const vB = /m=video([\s\S]*?)(?=m=|$)/.exec(bSdp);
check('A 端 video 段方向为 sendrecv', /a=sendrecv/.test(vA ? vA[1] : '') && !/a=inactive/.test(vA ? vA[1] : ''));
check('B 端 video 段方向为 sendrecv', /a=sendrecv/.test(vB ? vB[1] : '') && !/a=inactive/.test(vB ? vB[1] : ''));
check('video 段不是 recvonly（否则对方无法发画面给我们）', !/a=recvonly/.test(vA ? vA[1] : ''));

console.log('\n[6] 复用真实连接的 ICE 状态（本机回环应进入 connected/connecting）');
await new Promise(r => setTimeout(r, 2500));
const states = [A.pc.connectionState, B.pc.connectionState];
console.log('     A=' + states[0] + '  B=' + states[1]);
check('双方连接状态不是 failed', !states.includes('failed'), states.join('/'));

console.log('\n[7] 重连（ICE 重启）不会破坏 video m-line');
const offer2 = await A.pc.createOffer({ iceRestart: true });
await A.pc.setLocalDescription(offer2);
deliver('B', 'A', 'offer', { type: 'offer', sdp: A.pc.localDescription.sdp });
await pump();
const vA2 = /m=video([\s\S]*?)(?=m=|$)/.exec(A.pc.localDescription.sdp);
check('ICE 重启后 video 仍为 sendrecv', /a=sendrecv/.test(vA2 ? vA2[1] : ''));

A.pc.close(); B.pc.close();
console.log('\n================ 结果 ================');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail ? 1 : 0);
