import React, { useState, useEffect, useRef } from 'react';

const STUN_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ]
};

const PeerVideo = ({ stream, username, first_name, last_name }) => {
  const videoRef = useRef();

  useEffect(() => {
    if (videoRef.current && stream) {
      videoRef.current.srcObject = stream;
    }
  }, [stream]);

  return (
    <div className="video-box">
      <video ref={videoRef} autoPlay playsInline />
      <span className="video-name">{first_name ? `${first_name} ${last_name || ''}`.trim() : username}</span>
    </div>
  );
};

const VideoRoom = ({ socket, spaceId, onClose }) => {
  const [localStream, setLocalStream] = useState(null);
  const [peers, setPeers] = useState({});
  const [isMuted, setIsMuted] = useState(false);
  const [isVideoOff, setIsVideoOff] = useState(false);
  const [error, setError] = useState('');

  const localVideoRef = useRef();
  const peerConnections = useRef({});

  // 1. Initialize Media and Announce Presence
  useEffect(() => {
    let currentStream = null;
    let isMounted = true;

    navigator.mediaDevices.getUserMedia({ video: true, audio: true })
      .then(stream => {
        if (!isMounted) {
          // The component unmounted before the user granted permissions!
          // We must immediately stop this orphaned stream.
          stream.getTracks().forEach(track => track.stop());
          return;
        }

        currentStream = stream;
        setLocalStream(stream);
        if (localVideoRef.current) {
          localVideoRef.current.srcObject = stream;
        }
        // Tell everyone in the space we are joining the video call
        socket.emit('join-video-room', spaceId);
      })
      .catch(err => {
        if (isMounted) {
          console.error("Failed to acquire media:", err);
          setError('Camera or microphone permissions denied.');
        }
      });

    return () => {
      isMounted = false;
      // Cleanup on unmount
      if (currentStream) {
        currentStream.getTracks().forEach(track => track.stop());
      }
      if (localVideoRef.current) {
        localVideoRef.current.srcObject = null;
      }
      Object.values(peerConnections.current).forEach(pc => pc.close());
      peerConnections.current = {};
      socket.emit('leave-video-room', spaceId);
    };
  }, [spaceId, socket]);

  // 2. Setup WebRTC Listeners once local media is ready
  useEffect(() => {
    if (!localStream) return;

    const createPeerConnection = (userId, username, first_name, last_name) => {
      const pc = new RTCPeerConnection(STUN_SERVERS);
      peerConnections.current[userId] = pc;

      // Add local tracks to the connection
      localStream.getTracks().forEach(track => pc.addTrack(track, localStream));

      // Handle receiving tracks from the remote peer
      pc.ontrack = (event) => {
        setPeers(prev => ({
          ...prev,
          [userId]: { stream: event.streams[0], username, first_name, last_name }
        }));
      };

      // Send generated ICE candidates to the remote peer
      pc.onicecandidate = (event) => {
        if (event.candidate) {
          socket.emit('new-ice-candidate', { targetUserId: userId, candidate: event.candidate });
        }
      };

      return pc;
    };

    const handleUserJoined = async ({ userId, username, first_name, last_name }) => {
      console.log(`User joined: ${first_name ? first_name : username}`);
      const pc = createPeerConnection(userId, username, first_name, last_name);
      try {
        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);
        socket.emit('video-offer', { targetUserId: userId, offer });
      } catch (err) {
        console.error("Error creating offer:", err);
      }
    };

    const handleVideoOffer = async ({ senderId, offer, username, first_name, last_name }) => {
      console.log(`Received offer from ${first_name ? first_name : username}`);
      const pc = createPeerConnection(senderId, username, first_name, last_name);
      try {
        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        socket.emit('video-answer', { targetUserId: senderId, answer });
      } catch (err) {
        console.error("Error handling offer:", err);
      }
    };

    const handleVideoAnswer = async ({ senderId, answer }) => {
      console.log(`Received answer`);
      const pc = peerConnections.current[senderId];
      if (pc) {
        try {
          await pc.setRemoteDescription(new RTCSessionDescription(answer));
        } catch (err) {
          console.error("Error setting remote answer:", err);
        }
      }
    };

    const handleIceCandidate = async ({ senderId, candidate }) => {
      const pc = peerConnections.current[senderId];
      if (pc) {
        try {
          await pc.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
          console.error("Error adding ice candidate:", err);
        }
      }
    };

    const handleUserLeft = (userId) => {
      if (peerConnections.current[userId]) {
        peerConnections.current[userId].close();
        delete peerConnections.current[userId];
      }
      setPeers(prev => {
        const newPeers = { ...prev };
        delete newPeers[userId];
        return newPeers;
      });
    };

    socket.on('user-joined-video', handleUserJoined);
    socket.on('video-offer', handleVideoOffer);
    socket.on('video-answer', handleVideoAnswer);
    socket.on('new-ice-candidate', handleIceCandidate);
    socket.on('user-left-video', handleUserLeft);

    return () => {
      socket.off('user-joined-video', handleUserJoined);
      socket.off('video-offer', handleVideoOffer);
      socket.off('video-answer', handleVideoAnswer);
      socket.off('new-ice-candidate', handleIceCandidate);
      socket.off('user-left-video', handleUserLeft);
    };
  }, [localStream, socket]);

  const toggleMute = () => {
    if (localStream) {
      localStream.getAudioTracks().forEach(track => track.enabled = !track.enabled);
      setIsMuted(!isMuted);
    }
  };

  const toggleVideo = () => {
    if (localStream) {
      localStream.getVideoTracks().forEach(track => track.enabled = !track.enabled);
      setIsVideoOff(!isVideoOff);
    }
  };

  return (
    <div className="video-room-container">
      {error ? (
        <div className="video-error">
          <p>{error}</p>
          <button onClick={onClose} className="btn-secondary">Close</button>
        </div>
      ) : (
        <>
          <div className="video-grid">
            <div className="video-box local">
              <video ref={localVideoRef} autoPlay muted playsInline />
              <span className="video-name local-name">You {isMuted && '(Muted)'}</span>
            </div>
            {Object.entries(peers).map(([userId, peer]) => (
              <PeerVideo key={userId} stream={peer.stream} username={peer.username} first_name={peer.first_name} last_name={peer.last_name} />
            ))}
          </div>

          <div className="video-controls-bar">
            <button className={`video-btn ${isMuted ? 'active' : ''}`} onClick={toggleMute}>
              {isMuted ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="1" y1="1" x2="23" y2="23"></line><path d="M9 9v3a3 3 0 0 0 5.12 2.12M15 9.34V4a3 3 0 0 0-5.94-.6"></path><path d="M17 16.95A7 7 0 0 1 5 12v-2m14 0v2a7 7 0 0 1-.11 1.23"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z"></path><path d="M19 10v2a7 7 0 0 1-14 0v-2"></path><line x1="12" y1="19" x2="12" y2="23"></line><line x1="8" y1="23" x2="16" y2="23"></line></svg>
              )}
            </button>
            <button className={`video-btn ${isVideoOff ? 'active' : ''}`} onClick={toggleVideo}>
              {isVideoOff ? (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 16v1a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2m5.66 0H14a2 2 0 0 1 2 2v3.34l1 1L23 7v10"></path><line x1="1" y1="1" x2="23" y2="23"></line></svg>
              ) : (
                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>
              )}
            </button>
            <button className="video-btn danger" onClick={onClose} title="Leave Call">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M10.68 13.31a16 16 0 0 0 3.41 2.6l1.27-1.27a2 2 0 0 1 2.11-.45 12.84 12.84 0 0 0 2.81.7 2 2 0 0 1 1.72 2v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.42 19.42 0 0 1-3.33-2.67m-2.67-3.34a19.79 19.79 0 0 1-3.07-8.63A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72 12.84 12.84 0 0 0 .7 2.81 2 2 0 0 1-.45 2.11L8.09 9.91"></path><line x1="23" y1="1" x2="1" y2="23"></line></svg>
            </button>
          </div>
        </>
      )}
    </div>
  );
};

export default VideoRoom;
