/**
 * js/video-call.js
 * Handles WebRTC 1-on-1 video calling with Supabase Realtime signaling.
 */

document.addEventListener('DOMContentLoaded', () => {
    // We will initialize once currentUser and targetUserId are ready or poll for them.
    let peerConnection = null;
    let localStream = null;
    let signalingChannel = null;
    let isCaller = false;

    const ICE_SERVERS = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    };

    const startCallBtn = document.getElementById('start-video-call');
    const endCallBtn = document.getElementById('end-call');
    const toggleMicBtn = document.getElementById('toggle-mic');
    const toggleCameraBtn = document.getElementById('toggle-camera');
    const videoOverlay = document.getElementById('video-call-overlay');
    const localVideo = document.getElementById('local-video');
    const remoteVideo = document.getElementById('remote-video');

    if (!startCallBtn) return;

    // Helper to get sorted channel name
    function getChannelName(userId1, userId2) {
        const sorted = [userId1, userId2].sort();
        return `video-signal-${sorted[0]}-${sorted[1]}`;
    }

    async function initVideoCallModule() {
        // Wait until currentUser and targetUserId are available in window or scope
        const checkInterval = setInterval(async () => {
            if (typeof currentUser !== 'undefined' && currentUser && typeof targetUserId !== 'undefined' && targetUserId) {
                clearInterval(checkInterval);
                setupSignalingChannel();
            }
        }, 300);
    }

    function setupSignalingChannel() {
        const channelName = getChannelName(currentUser.id, targetUserId);
        console.log("Setting up WebRTC signaling channel:", channelName);

        signalingChannel = window.sbClient.channel(channelName, {
            config: { broadcast: { self: false } }
        });

        signalingChannel.on('broadcast', { event: 'webrtc-signal' }, async ({ payload }) => {
            console.log("Received WebRTC signal event:", payload.type);
            if (payload.sender === currentUser.id) return; // Ignore own messages if any

            if (payload.type === 'offer') {
                console.log("Incoming video call offer received...");
                // Prompt incoming call or auto-answer
                const accept = confirm(`Incoming video call from ${targetUser?.full_name || 'Member'}. Accept?`);
                if (accept) {
                    isCaller = false;
                    await startLocalMedia();
                    showVideoUI();
                    await handleOffer(payload.offer);
                } else {
                    sendSignal({ type: 'reject', sender: currentUser.id });
                }
            } else if (payload.type === 'answer') {
                console.log("Received answer from peer");
                if (peerConnection) {
                    await peerConnection.setRemoteDescription(new RTCSessionDescription(payload.answer));
                }
            } else if (payload.type === 'ice-candidate') {
                console.log("Received ICE candidate");
                if (peerConnection && payload.candidate) {
                    try {
                        await peerConnection.addIceCandidate(new RTCIceCandidate(payload.candidate));
                    } catch (e) {
                        console.error("Error adding received ICE candidate", e);
                    }
                }
            } else if (payload.type === 'end-call' || payload.type === 'reject') {
                console.log("Call ended or rejected by peer");
                terminateCall(false);
                alert("The video call has ended.");
            }
        });

        signalingChannel.subscribe((status) => {
            console.log("Signaling channel subscription status:", status);
        });
    }

    function sendSignal(data) {
        if (!signalingChannel) return;
        signalingChannel.send({
            type: 'broadcast',
            event: 'webrtc-signal',
            payload: { ...data, sender: currentUser.id }
        });
    }

    async function startLocalMedia() {
        try {
            localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
            localVideo.srcObject = localStream;
            console.log("Local camera and microphone streams acquired successfully.");
        } catch (error) {
            console.error("Error accessing media devices:", error);
            alert("Could not access camera or microphone. Please check permission settings.");
            throw error;
        }
    }

    function showVideoUI() {
        videoOverlay.classList.remove('hidden');
    }

    function hideVideoUI() {
        videoOverlay.classList.add('hidden');
        if (localVideo) localVideo.srcObject = null;
        if (remoteVideo) remoteVideo.srcObject = null;
    }

    function createPeerConnection() {
        if (peerConnection) return;
        peerConnection = new RTCPeerConnection(ICE_SERVERS);

        // Add local tracks to peer connection
        if (localStream) {
            localStream.getTracks().forEach(track => {
                peerConnection.addTrack(track, localStream);
            });
        }

        // Handle incoming remote track
        peerConnection.ontrack = (event) => {
            console.log("Remote track received:", event.streams[0]);
            remoteVideo.srcObject = event.streams[0];
        };

        // Handle ICE candidates
        peerConnection.onicecandidate = (event) => {
            if (event.candidate) {
                sendSignal({
                    type: 'ice-candidate',
                    candidate: event.candidate
                });
            }
        };

        peerConnection.onconnectionstatechange = () => {
            console.log("Peer connection state changed:", peerConnection.connectionState);
            if (peerConnection.connectionState === 'disconnected' || peerConnection.connectionState === 'failed' || peerConnection.connectionState === 'closed') {
                terminateCall(false);
            }
        };
    }

    // Start Call Button Click
    startCallBtn.addEventListener('click', async () => {
        try {
            isCaller = true;
            await startLocalMedia();
            showVideoUI();
            createPeerConnection();

            const offer = await peerConnection.createOffer();
            await peerConnection.setLocalDescription(offer);

            console.log("Created and set local offer, sending via Supabase Realtime...");
            sendSignal({
                type: 'offer',
                offer: offer
            });
        } catch (e) {
            console.error("Failed to start video call:", e);
            hideVideoUI();
        }
    });

    async function handleOffer(offer) {
        createPeerConnection();
        await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await peerConnection.createAnswer();
        await peerConnection.setLocalDescription(answer);

        console.log("Created and set local answer, sending via Supabase Realtime...");
        sendSignal({
            type: 'answer',
            answer: answer
        });
    }

    function terminateCall(sendEndSignal = true) {
        if (sendEndSignal) {
            sendSignal({ type: 'end-call' });
        }

        if (localStream) {
            localStream.getTracks().forEach(track => track.stop());
            localStream = null;
        }

        if (peerConnection) {
            peerConnection.close();
            peerConnection = null;
        }

        hideVideoUI();
        console.log("Call terminated and resources cleaned up.");
    }

    // End Call Button
    endCallBtn.addEventListener('click', () => {
        terminateCall(true);
    });

    // Toggle Mic
    let micEnabled = true;
    toggleMicBtn.addEventListener('click', () => {
        if (!localStream) return;
        micEnabled = !micEnabled;
        localStream.getAudioTracks().forEach(track => {
            track.enabled = micEnabled;
        });
        toggleMicBtn.className = micEnabled 
            ? "bg-gray-700 hover:bg-gray-600 text-white w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-colors"
            : "bg-red-600 hover:bg-red-700 text-white w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-colors";
        toggleMicBtn.innerHTML = micEnabled ? '<i class="fas fa-microphone text-lg"></i>' : '<i class="fas fa-microphone-slash text-lg"></i>';
    });

    // Toggle Camera
    let cameraEnabled = true;
    toggleCameraBtn.addEventListener('click', () => {
        if (!localStream) return;
        cameraEnabled = !cameraEnabled;
        localStream.getVideoTracks().forEach(track => {
            track.enabled = cameraEnabled;
        });
        toggleCameraBtn.className = cameraEnabled
            ? "bg-gray-700 hover:bg-gray-600 text-white w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-colors"
            : "bg-red-600 hover:bg-red-700 text-white w-12 h-12 rounded-full flex items-center justify-center shadow-lg transition-colors";
        toggleCameraBtn.innerHTML = cameraEnabled ? '<i class="fas fa-video text-lg"></i>' : '<i class="fas fa-video-slash text-lg"></i>';
    });

    initVideoCallModule();
});
