import React, { useState, useEffect, useRef, useCallback } from 'react';

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

// ─── Audio Level Analyzer ───
const useAudioLevel = (stream) => {
  const [isSpeaking, setIsSpeaking] = useState(false);
  const analyserRef = useRef(null);
  const animFrameRef = useRef(null);

  useEffect(() => {
    if (!stream) return;
    const audioTracks = stream.getAudioTracks();
    if (audioTracks.length === 0) return;

    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      const src = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.5;
      src.connect(analyser);
      analyserRef.current = analyser;

      const dataArray = new Uint8Array(analyser.frequencyBinCount);
      const check = () => {
        analyser.getByteFrequencyData(dataArray);
        const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
        setIsSpeaking(avg > 15);
        animFrameRef.current = requestAnimationFrame(check);
      };
      check();

      return () => {
        cancelAnimationFrame(animFrameRef.current);
        ctx.close().catch(() => {});
      };
    } catch (e) {
      console.warn('AudioContext not supported for speaking detection');
    }
  }, [stream]);

  return isSpeaking;
};

// ─── Connection Quality Hook ───
const useConnectionQuality = (pc) => {
  const [quality, setQuality] = useState({ level: 3, rtt: 0, packetLoss: 0, bitrate: 0 });
  const prevBytesRef = useRef(0);
  const prevTimestampRef = useRef(0);

  useEffect(() => {
    if (!pc) return;
    const interval = setInterval(async () => {
      try {
        const stats = await pc.getStats();
        let rtt = 0, packetsLost = 0, packetsReceived = 0, bytesReceived = 0, timestamp = 0;
        stats.forEach(report => {
          if (report.type === 'candidate-pair' && report.state === 'succeeded') {
            rtt = report.currentRoundTripTime * 1000 || 0;
          }
          if (report.type === 'inbound-rtp' && report.kind === 'video') {
            packetsLost = report.packetsLost || 0;
            packetsReceived = report.packetsReceived || 0;
            bytesReceived = report.bytesReceived || 0;
            timestamp = report.timestamp || 0;
          }
        });

        const packetLoss = packetsReceived > 0 ? (packetsLost / (packetsReceived + packetsLost)) * 100 : 0;
        const elapsed = timestamp && prevTimestampRef.current ? (timestamp - prevTimestampRef.current) / 1000 : 1;
        const bitrate = elapsed > 0 ? ((bytesReceived - prevBytesRef.current) * 8 / elapsed / 1000) : 0;
        prevBytesRef.current = bytesReceived;
        prevTimestampRef.current = timestamp;

        let level = 3;
        if (rtt > 300 || packetLoss > 10) level = 1;
        else if (rtt > 150 || packetLoss > 3) level = 2;

        setQuality({ level, rtt: Math.round(rtt), packetLoss: Math.round(packetLoss * 10) / 10, bitrate: Math.round(bitrate) });
      } catch {}
    }, 3000);
    return () => clearInterval(interval);
  }, [pc]);

  return quality;
};

// ─── Quality Dots Component ───
const QualityDots = ({ level, rtt, packetLoss, bitrate }) => {
  const colors = { 3: '#4CAF50', 2: '#FF9800', 1: '#f44336' };
  const color = colors[level] || colors[3];
  return (
    <div className="quality-dots" title={`RTT: ${rtt}ms | Loss: ${packetLoss}% | ${bitrate} kbps`}>
      <span style={{ color, opacity: 1 }}>●</span>
      <span style={{ color, opacity: level >= 2 ? 1 : 0.2 }}>●</span>
      <span style={{ color, opacity: level >= 3 ? 1 : 0.2 }}>●</span>
    </div>
  );
};

// ─── Peer Video Tile ───
const PeerVideo = ({ stream, username, first_name, last_name, avatar, isMuted, pc, isPinned, onPin, isScreenShare }) => {
  const videoRef = useRef();
  const isSpeaking = useAudioLevel(stream);
  const quality = useConnectionQuality(pc);

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  const displayName = first_name ? `${first_name} ${last_name || ''}`.trim() : username;

  return (
    <div
      className={`video-box ${isSpeaking ? 'speaking' : ''} ${isPinned ? 'pinned' : ''} ${isScreenShare ? 'screen-share' : ''}`}
      onClick={onPin}
    >
      {stream ? (
        <video ref={videoRef} autoPlay playsInline />
      ) : (
        <div className="video-avatar-fallback">
          {avatar ? (
            <img src={avatar} alt={displayName} className="video-avatar-img" />
          ) : (
            <div className="video-avatar-initial">{(first_name || username || '?').charAt(0).toUpperCase()}</div>
          )}
        </div>
      )}
      <div className="video-tile-overlay">
        <span className="video-name">{displayName} {isScreenShare && '(Screen)'}</span>
        <div className="video-tile-badges">
          {isMuted && <span className="badge-muted"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path></svg></span>}
          <QualityDots {...quality} />
        </div>
      </div>
    </div>
  );
};

// ─── Main VideoRoom Component ───
const VideoRoom = ({ socket, spaceId, onClose, audioOnly: initialAudioOnly = false, profileData, avatar: myAvatar }) => {
  // Media State
  const [localStream, setLocalStream] = useState(null);
  const [screenStream, setScreenStream] = useState(null);
  const [peers, setPeers] = useState({});
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(initialAudioOnly);
  const [isScreenSharing, setIsScreenSharing] = useState(false);
  const [audioOnly, setAudioOnly] = useState(initialAudioOnly);
  const [error, setError] = useState('');

  // Pre-join Lobby State
  const [inLobby, setInLobby] = useState(true);
  const [lobbyStream, setLobbyStream] = useState(null);
  const [lobbyMicLevel, setLobbyMicLevel] = useState(0);
  const [devices, setDevices] = useState({ videoinput: [], audioinput: [], audiooutput: [] });
  const [selectedCamera, setSelectedCamera] = useState('');
  const [selectedMic, setSelectedMic] = useState('');
  const [selectedSpeaker, setSelectedSpeaker] = useState('');
  const lobbyVideoRef = useRef();
  const lobbyAnalyserRef = useRef(null);
  const lobbyAnimFrameRef = useRef(null);

  // Browser Capability Detection
  const canScreenShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const canFullscreen = typeof document.documentElement?.requestFullscreen === 'function'
    || typeof document.documentElement?.webkitRequestFullscreen === 'function';

  // UI State
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [isPiP, setIsPiP] = useState(false);
  const [pinnedUserId, setPinnedUserId] = useState(null);
  const [screenSharer, setScreenSharer] = useState(null);
  const [callDuration, setCallDuration] = useState(0);
  const [showParticipantTray, setShowParticipantTray] = useState(true);

  const localVideoRef = useRef();
  const peerConnections = useRef({});
  const containerRef = useRef();
  const callStartRef = useRef(Date.now());

  // ─── Call Duration Timer (only when in call) ───
  useEffect(() => {
    if (inLobby) return;
    callStartRef.current = Date.now();
    const timer = setInterval(() => {
      setCallDuration(Math.floor((Date.now() - callStartRef.current) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [inLobby]);

  const formatDuration = (s) => {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}:${m.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    return `${m}:${sec.toString().padStart(2, '0')}`;
  };

  // ─── Lobby: Enumerate Devices + Preview ───
  useEffect(() => {
    if (!inLobby) return;
    let isMounted = true;
    let previewStream = null;

    const initLobby = async () => {
      try {
        // Request permission first (needed to enumerate devices with labels)
        const constraints = {
          audio: selectedMic ? { deviceId: { exact: selectedMic } } : true,
          video: audioOnly ? false : (selectedCamera ? { deviceId: { exact: selectedCamera } } : { facingMode: 'user' })
        };
        previewStream = await navigator.mediaDevices.getUserMedia(constraints);
        if (!isMounted) { previewStream.getTracks().forEach(t => t.stop()); return; }
        
        setLobbyStream(previewStream);
        if (lobbyVideoRef.current) lobbyVideoRef.current.srcObject = previewStream;

        // Enumerate devices
        if (navigator.mediaDevices.enumerateDevices) {
          const allDevices = await navigator.mediaDevices.enumerateDevices();
          const grouped = { videoinput: [], audioinput: [], audiooutput: [] };
          allDevices.forEach(d => {
            if (grouped[d.kind]) grouped[d.kind].push(d);
          });
          if (isMounted) setDevices(grouped);
        }

        // Mic level meter
        try {
          const AudioCtx = window.AudioContext || window.webkitAudioContext;
          if (AudioCtx) {
            const ctx = new AudioCtx();
            const src = ctx.createMediaStreamSource(previewStream);
            const analyser = ctx.createAnalyser();
            analyser.fftSize = 256;
            analyser.smoothingTimeConstant = 0.5;
            src.connect(analyser);
            lobbyAnalyserRef.current = { ctx, analyser };

            const dataArray = new Uint8Array(analyser.frequencyBinCount);
            const poll = () => {
              analyser.getByteFrequencyData(dataArray);
              const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
              if (isMounted) setLobbyMicLevel(Math.min(100, Math.round(avg * 2)));
              lobbyAnimFrameRef.current = requestAnimationFrame(poll);
            };
            poll();
          }
        } catch (e) { /* AudioContext not available — mic meter won't show */ }
      } catch (err) {
        if (isMounted) {
          console.error('Lobby media error:', err);
          setError('Camera or microphone access denied. Please check browser permissions.');
        }
      }
    };
    initLobby();

    return () => {
      isMounted = false;
      // Only stop tracks if the stream was NOT transferred to the call
      if (previewStream && previewStream !== transferredStreamRef.current) {
        previewStream.getTracks().forEach(t => t.stop());
      }
      if (lobbyAnimFrameRef.current) cancelAnimationFrame(lobbyAnimFrameRef.current);
      if (lobbyAnalyserRef.current?.ctx) lobbyAnalyserRef.current.ctx.close().catch(() => {});
    };
  }, [inLobby, audioOnly, selectedCamera, selectedMic]);

  // Ref to hold the lobby stream that gets transferred to the call
  const transferredStreamRef = useRef(null);

  // ─── Join Call from Lobby ───
  const joinCall = () => {
    // Transfer the lobby stream instead of destroying it — avoids a second getUserMedia call
    if (lobbyStream) {
      transferredStreamRef.current = lobbyStream;
    }
    // Only clean up the mic level meter, NOT the stream tracks
    if (lobbyAnimFrameRef.current) cancelAnimationFrame(lobbyAnimFrameRef.current);
    if (lobbyAnalyserRef.current?.ctx) lobbyAnalyserRef.current.ctx.close().catch(() => {});
    setLobbyStream(null);
    setInLobby(false);
  };

  // ─── Initialize Media (after leaving lobby) ───
  useEffect(() => {
    if (inLobby) return;
    let currentStream = null;
    let isMounted = true;

    const initMedia = async () => {
      try {
        let stream;
        const transferred = transferredStreamRef.current;
        transferredStreamRef.current = null;

        if (transferred && transferred.active) {
          // Reuse the lobby stream directly — no second getUserMedia needed
          stream = transferred;
        } else {
          // Fallback: acquire fresh media (e.g. if lobby was skipped or stream died)
          if (transferred) transferred.getTracks().forEach(t => t.stop());
          const constraints = {
            audio: selectedMic
              ? { deviceId: { exact: selectedMic }, noiseSuppression: true, echoCancellation: true, autoGainControl: true }
              : { noiseSuppression: true, echoCancellation: true, autoGainControl: true },
            video: audioOnly ? false : (selectedCamera
              ? { deviceId: { exact: selectedCamera }, width: { ideal: 1280 }, height: { ideal: 720 } }
              : { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' })
          };
          stream = await navigator.mediaDevices.getUserMedia(constraints);
        }

        if (!isMounted) { stream.getTracks().forEach(t => t.stop()); return; }
        currentStream = stream;
        setLocalStream(stream);
        if (localVideoRef.current) localVideoRef.current.srcObject = stream;
        
        // Emit ringing notification to the space
        socket.emit('call-ringing', { spaceId });
        // Join the video room
        socket.emit('join-video-room', spaceId);
      } catch (err) {
        if (isMounted) {
          console.error("Failed to acquire media:", err);
          setError('Camera or microphone permissions denied. Check browser settings.');
        }
      }
    };

    initMedia();

    return () => {
      isMounted = false;
      if (currentStream) currentStream.getTracks().forEach(t => t.stop());
      if (localVideoRef.current) localVideoRef.current.srcObject = null;
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      socket.emit('leave-video-room', spaceId);
    };
  }, [inLobby, spaceId, socket, audioOnly, selectedCamera, selectedMic]);

  // ─── Create Peer Connection (with reconnection) ───
  const createPeerConnection = useCallback((userId, userInfo) => {
    const pc = new RTCPeerConnection(STUN_SERVERS);
    peerConnections.current[userId] = pc;

    // Add local tracks
    if (localStream) {
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
    }

    // Handle incoming tracks
    pc.ontrack = (event) => {
      setPeers(prev => ({
        ...prev,
        [userId]: { ...prev[userId], ...userInfo, stream: event.streams[0] }
      }));
    };

    // ICE candidates
    pc.onicecandidate = (event) => {
      if (event.candidate) {
        socket.emit('new-ice-candidate', { targetUserId: userId, candidate: event.candidate });
      }
    };

    // Connection state monitoring for reconnection
    pc.oniceconnectionstatechange = () => {
      const state = pc.iceConnectionState;
      setPeers(prev => {
        if (!prev[userId]) return prev;
        return { ...prev, [userId]: { ...prev[userId], connectionState: state } };
      });
      
      if (state === 'failed') {
        console.warn(`ICE failed for ${userId}, attempting restart`);
        pc.restartIce();
      }
      if (state === 'disconnected') {
        // Give it 5 seconds to recover before showing warning
        setTimeout(() => {
          if (pc.iceConnectionState === 'disconnected') {
            setPeers(prev => {
              if (!prev[userId]) return prev;
              return { ...prev, [userId]: { ...prev[userId], connectionState: 'warning' } };
            });
          }
        }, 5000);
      }
    };

    return pc;
  }, [localStream, socket]);

  // ─── WebRTC Event Listeners ───
  useEffect(() => {
    if (!localStream) return;

    const handleUserJoined = async ({ userId, username, first_name, last_name, avatar }) => {
      const pc = createPeerConnection(userId, { username, first_name, last_name, avatar });
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('video-offer', { targetUserId: userId, offer });
      } catch (err) { console.error("Error creating offer:", err); }
    };

    const handleVideoOffer = async ({ senderId, offer, username, first_name, last_name, avatar }) => {
      const pc = createPeerConnection(senderId, { username, first_name, last_name, avatar });
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('video-answer', { targetUserId: senderId, answer });
      } catch (err) { console.error("Error handling offer:", err); }
    };

    const handleVideoAnswer = async ({ senderId, answer }) => {
      const pc = peerConnections.current[senderId];
      if (pc) {
        try { await pc.setRemoteDescription(new RTCSessionDescription(answer)); }
        catch (err) { console.error("Error setting remote answer:", err); }
      }
    };

    const handleIceCandidate = async ({ senderId, candidate }) => {
      const pc = peerConnections.current[senderId];
      if (pc) {
        try { await pc.addIceCandidate(new RTCIceCandidate(candidate)); }
        catch (err) { console.error("Error adding ICE candidate:", err); }
      }
    };

    const handleUserLeft = (userId) => {
      if (peerConnections.current[userId]) {
        peerConnections.current[userId].close();
        delete peerConnections.current[userId];
      }
      setPeers(prev => { const n = { ...prev }; delete n[userId]; return n; });
      if (pinnedUserId === userId) setPinnedUserId(null);
      if (screenSharer === userId) setScreenSharer(null);
    };

    const handleScreenShareStarted = ({ userId, username, first_name }) => {
      setScreenSharer(userId);
      setPinnedUserId(userId);
    };

    const handleScreenShareStopped = ({ userId }) => {
      if (screenSharer === userId) {
        setScreenSharer(null);
        setPinnedUserId(null);
      }
    };

    socket.on('user-joined-video', handleUserJoined);
    socket.on('video-offer', handleVideoOffer);
    socket.on('video-answer', handleVideoAnswer);
    socket.on('new-ice-candidate', handleIceCandidate);
    socket.on('user-left-video', handleUserLeft);
    socket.on('screen-share-started', handleScreenShareStarted);
    socket.on('screen-share-stopped', handleScreenShareStopped);

    return () => {
      socket.off('user-joined-video', handleUserJoined);
      socket.off('video-offer', handleVideoOffer);
      socket.off('video-answer', handleVideoAnswer);
      socket.off('new-ice-candidate', handleIceCandidate);
      socket.off('user-left-video', handleUserLeft);
      socket.off('screen-share-started', handleScreenShareStarted);
      socket.off('screen-share-stopped', handleScreenShareStopped);
    };
  }, [localStream, socket, createPeerConnection, pinnedUserId, screenSharer]);

  // ─── Controls ───
  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(t => t.enabled = !t.enabled);
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(t => t.enabled = !t.enabled);
      setIsVideoOff(!isVideoOff);
    }
  };

  const toggleScreenShare = async () => {
    if (isScreenSharing) {
      // Stop screen share
      if (screenStream) {
        screenStream.getTracks().forEach(t => t.stop());
        setScreenStream(null);
      }
      // Restore camera track in all peer connections
      if (localStream) {
        const videoTrack = localStream.getVideoTracks()[0];
        if (videoTrack) {
          Object.values(peerConnections.current).forEach(pc => {
            const sender = pc.getSenders().find(s => s.track?.kind === 'video');
            if (sender) sender.replaceTrack(videoTrack);
          });
        }
      }
      setIsScreenSharing(false);
      socket.emit('screen-share-stopped', { spaceId });
    } else {
      try {
        const screen = await navigator.mediaDevices.getDisplayMedia({ video: { cursor: 'always' }, audio: false });
        setScreenStream(screen);
        
        // Replace video track in all peer connections
        const screenTrack = screen.getVideoTracks()[0];
        Object.values(peerConnections.current).forEach(pc => {
          const sender = pc.getSenders().find(s => s.track?.kind === 'video');
          if (sender) sender.replaceTrack(screenTrack);
        });

        // When user stops sharing via browser UI
        screenTrack.onended = () => {
          toggleScreenShare(); // recursive call to restore camera
        };

        setIsScreenSharing(true);
        socket.emit('screen-share-started', { spaceId });
      } catch (err) {
        console.error('Screen share failed:', err);
      }
    }
  };

  const toggleFullscreen = () => {
    if (!isFullscreen) {
      const el = containerRef.current;
      if (el?.requestFullscreen) el.requestFullscreen();
      else if (el?.webkitRequestFullscreen) el.webkitRequestFullscreen(); // Safari
      setIsPiP(false);
    } else {
      if (document.exitFullscreen) document.exitFullscreen();
      else if (document.webkitExitFullscreen) document.webkitExitFullscreen(); // Safari
    }
    setIsFullscreen(!isFullscreen);
  };

  const togglePiP = () => {
    if (isFullscreen) {
      document.exitFullscreen?.();
      setIsFullscreen(false);
    }
    setIsPiP(!isPiP);
  };

  // ─── Layout Logic ───
  const peerEntries = Object.entries(peers);
  const totalParticipants = peerEntries.length + 1; // +1 for self
  const hasPinned = pinnedUserId && peers[pinnedUserId];

  const getGridClass = () => {
    if (hasPinned) return 'layout-presentation';
    if (totalParticipants <= 1) return 'layout-solo';
    if (totalParticipants <= 2) return 'layout-duo';
    if (totalParticipants <= 4) return 'layout-quad';
    if (totalParticipants <= 6) return 'layout-six';
    return 'layout-many';
  };

  // ─── Render ───
  const localIsSpeaking = useAudioLevel(localStream);

  return (
    <div
      ref={containerRef}
      className={`video-room-container ${isFullscreen ? 'fullscreen' : ''} ${isPiP ? 'pip-mode' : ''}`}
    >
      {error ? (
        <div className="video-error">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="8" x2="12" y2="12"></line><line x1="12" y1="16" x2="12.01" y2="16"></line></svg>
          <p style={{ fontSize: '1.1rem', fontWeight: 500 }}>{error}</p>
          <button onClick={onClose} className="btn-secondary">Close</button>
        </div>
      ) : inLobby ? (
        /* ─── Pre-Join Lobby ─── */
        <div className="video-lobby">
          <div className="lobby-preview">
            {!audioOnly ? (
              <video ref={lobbyVideoRef} autoPlay muted playsInline className="lobby-video" />
            ) : (
              <div className="video-avatar-fallback">
                {myAvatar ? (
                  <img src={myAvatar} alt="You" className="video-avatar-img" />
                ) : (
                  <div className="video-avatar-initial">
                    {(profileData?.first_name || 'Y').charAt(0).toUpperCase()}
                  </div>
                )}
              </div>
            )}
            <div className="lobby-mic-meter">
              <div className="mic-meter-fill" style={{ width: `${lobbyMicLevel}%` }}></div>
            </div>
          </div>

          <div className="lobby-controls">
            <h3 style={{ margin: '0 0 12px', color: 'rgba(255,255,255,0.9)', fontWeight: 500 }}>Ready to join?</h3>

            {/* Device Selectors */}
            {devices.audioinput.length > 1 && (
              <div className="device-select-row">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path></svg>
                <select value={selectedMic} onChange={(e) => setSelectedMic(e.target.value)} className="device-select">
                  {devices.audioinput.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Microphone ${d.deviceId.slice(0, 5)}`}</option>
                  ))}
                </select>
              </div>
            )}

            {!audioOnly && devices.videoinput.length > 1 && (
              <div className="device-select-row">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
                <select value={selectedCamera} onChange={(e) => setSelectedCamera(e.target.value)} className="device-select">
                  {devices.videoinput.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Camera ${d.deviceId.slice(0, 5)}`}</option>
                  ))}
                </select>
              </div>
            )}

            {devices.audiooutput.length > 1 && (
              <div className="device-select-row">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5"></polygon><path d="M19.07 4.93a10 10 0 0 1 0 14.14M15.54 8.46a5 5 0 0 1 0 7.07"></path></svg>
                <select value={selectedSpeaker} onChange={(e) => setSelectedSpeaker(e.target.value)} className="device-select">
                  {devices.audiooutput.map(d => (
                    <option key={d.deviceId} value={d.deviceId}>{d.label || `Speaker ${d.deviceId.slice(0, 5)}`}</option>
                  ))}
                </select>
              </div>
            )}

            {/* Audio-only toggle */}
            <label className="lobby-toggle">
              <input type="checkbox" checked={audioOnly} onChange={(e) => setAudioOnly(e.target.checked)} />
              <span>Audio only (no camera)</span>
            </label>

            <div className="lobby-actions">
              <button className="ring-accept" onClick={joinCall} style={{ padding: '10px 28px', fontSize: '0.95rem' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginRight: '6px', verticalAlign: 'middle' }}><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
                Join Call
              </button>
              <button className="ring-decline" onClick={onClose} style={{ padding: '10px 28px', fontSize: '0.95rem' }}>Cancel</button>
            </div>
          </div>
        </div>
      ) : (
        <>
          {/* Call Header (fullscreen / PiP) */}
          {(isFullscreen || isPiP) && (
            <div className="video-header">
              <span className="call-timer">{formatDuration(callDuration)}</span>
              <span className="call-participants">{totalParticipants} participant{totalParticipants !== 1 ? 's' : ''}</span>
            </div>
          )}

          {/* Video Grid */}
          <div className={`video-grid ${getGridClass()}`}>
            {/* Pinned/Presentation view */}
            {hasPinned && (
              <div className="video-stage">
                <PeerVideo
                  stream={peers[pinnedUserId].stream}
                  username={peers[pinnedUserId].username}
                  first_name={peers[pinnedUserId].first_name}
                  last_name={peers[pinnedUserId].last_name}
                  avatar={peers[pinnedUserId].avatar}
                  isMuted={false}
                  pc={peerConnections.current[pinnedUserId]}
                  isPinned={true}
                  onPin={() => setPinnedUserId(null)}
                  isScreenShare={screenSharer === pinnedUserId}
                />
              </div>
            )}

            {/* Participant Tiles */}
            <div className={`video-tiles ${hasPinned ? 'sidebar-tiles' : ''}`}>
              {/* Local Video */}
              <div
                className={`video-box local ${localIsSpeaking ? 'speaking' : ''}`}
                onClick={() => setPinnedUserId(null)}
              >
                {!audioOnly && !isVideoOff ? (
                  <video ref={localVideoRef} autoPlay muted playsInline />
                ) : (
                  <div className="video-avatar-fallback">
                    {myAvatar ? (
                      <img src={myAvatar} alt="You" className="video-avatar-img" />
                    ) : (
                      <div className="video-avatar-initial">
                        {(profileData?.first_name || 'Y').charAt(0).toUpperCase()}
                      </div>
                    )}
                  </div>
                )}
                <div className="video-tile-overlay">
                  <span className="video-name">You {isScreenSharing && '(Sharing)'}</span>
                  <div className="video-tile-badges">
                    {isMuted && <span className="badge-muted"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path></svg></span>}
                  </div>
                </div>
              </div>

              {/* Remote Peers */}
              {peerEntries
                .filter(([userId]) => !hasPinned || userId !== pinnedUserId)
                .map(([userId, peer]) => (
                  <PeerVideo
                    key={userId}
                    stream={peer.stream}
                    username={peer.username}
                    first_name={peer.first_name}
                    last_name={peer.last_name}
                    avatar={peer.avatar}
                    isMuted={false}
                    pc={peerConnections.current[userId]}
                    isPinned={false}
                    onPin={() => setPinnedUserId(userId)}
                    isScreenShare={screenSharer === userId}
                  />
                ))}
            </div>
          </div>

          {/* Controls Bar */}
          <div className="video-controls-bar">
            <div className="controls-left">
              <span className="call-timer-inline">{formatDuration(callDuration)}</span>
            </div>

            <div className="controls-center">
              <button className={`video-btn ${isMuted ? 'active' : ''}`} onClick={toggleMute} title={isMuted ? 'Unmute' : 'Mute'}>
                {isMuted ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
                )}
              </button>

              <button className={`video-btn ${isVideoOff ? 'active' : ''}`} onClick={toggleVideo} title={isVideoOff ? 'Turn on camera' : 'Turn off camera'}>
                {isVideoOff ? (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
                ) : (
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
                )}
              </button>

              {canScreenShare && (
                <button className={`video-btn ${isScreenSharing ? 'active screen-active' : ''}`} onClick={toggleScreenShare} title={isScreenSharing ? 'Stop sharing' : 'Share screen'}>
                  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2" ry="2"></rect><line x1="8" y1="21" x2="16" y2="21"></line><line x1="12" y1="17" x2="12" y2="21"></line></svg>
                </button>
              )}

              {canFullscreen && (
                <button className="video-btn" onClick={toggleFullscreen} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'}>
                  {isFullscreen ? (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3v3a2 2 0 0 1-2 2H3m18 0h-3a2 2 0 0 1-2-2V3m0 18v-3a2 2 0 0 1 2-2h3M3 16h3a2 2 0 0 1 2 2v3"></path></svg>
                  ) : (
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8 3H5a2 2 0 0 0-2 2v3m18 0V5a2 2 0 0 0-2-2h-3m0 18h3a2 2 0 0 0 2-2v-3M3 16v3a2 2 0 0 0 2 2h3"></path></svg>
                  )}
                </button>
              )}

              <button className="video-btn" onClick={togglePiP} title={isPiP ? 'Expand' : 'Minimize'}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="20" rx="2"></rect><rect x="11" y="11" width="9" height="9" rx="1" fill="currentColor" opacity="0.3"></rect></svg>
              </button>

              <button className="video-btn danger" onClick={onClose} title="Leave Call">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>
              </button>
            </div>

            <div className="controls-right">
              <button className="video-btn participants-toggle" onClick={() => setShowParticipantTray(!showParticipantTray)} title="Participants">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path><circle cx="9" cy="7" r="4"></circle><path d="M23 21v-2a4 4 0 0 0-3-3.87"></path><path d="M16 3.13a4 4 0 0 1 0 7.75"></path></svg>
                <span className="participant-count-badge">{totalParticipants}</span>
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default VideoRoom;
