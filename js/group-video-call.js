(function () {
    'use strict';

    const params = new URLSearchParams(window.location.search);
    const sessionId = params.get('session');
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const client = window.sbClient || window.supabaseClient;

    const statusEl = document.getElementById('call-status');
    const errorEl = document.getElementById('call-error');
    const groupNameEl = document.getElementById('group-name');
    const localPlayer = document.getElementById('local-player');
    const remoteGrid = document.getElementById('remote-grid');
    const remoteEmpty = document.getElementById('remote-empty');
    const micButton = document.getElementById('mic-toggle');
    const cameraButton = document.getElementById('camera-toggle');
    const leaveButton = document.getElementById('leave-call');
    const endButton = document.getElementById('end-call');

    let currentUser = null;
    let session = null;
    let credentials = null;
    let rtcClient = null;
    let audioTrack = null;
    let videoTrack = null;
    let joined = false;
    let joining = false;
    let muted = false;
    let cameraOff = false;
    let ending = false;
    let terminal = false;
    let renewing = false;
    let expiryTimer = null;
    let sessionChannel = null;
    const remoteUsers = new Map();

    function showStatus(message) { statusEl.textContent = message || ''; }
    function showError(message) {
        errorEl.textContent = message || 'The group call could not be started.';
        errorEl.classList.remove('hidden');
        showStatus('Unable to join the group call.');
    }
    function escapeText(value) { return String(value || '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch])); }

    async function getCallAuthorization() {
        const { data, error } = await client.functions.invoke('group-agora-token', { body: { sessionId } });
        if (error) throw new Error(error.message || 'Could not obtain group-call authorization.');
        if (!data || data.sessionId !== sessionId || typeof data.appId !== 'string' ||
            typeof data.token !== 'string' || typeof data.channelName !== 'string' ||
            !Number.isSafeInteger(data.uid) || !Number.isFinite(Number(data.expiresAt)) ||
            !Number.isFinite(Number(data.callExpiresAt))) {
            throw new Error('The group-call authorization response is invalid.');
        }
        return data;
    }

    async function releaseMedia() {
        micButton.disabled = true;
        cameraButton.disabled = true;
        if (audioTrack) { try { audioTrack.close(); } catch (_) {} audioTrack = null; }
        if (videoTrack) { try { videoTrack.close(); } catch (_) {} videoTrack = null; }
        if (rtcClient && joined) {
            try { await rtcClient.leave(); } catch (error) { console.warn('Agora leave warning:', error); }
        }
        joined = false;
    }

    function removeRemoteUser(uid) {
        const tileId = `remote-tile-${String(uid).replace(/[^0-9]/g, '')}`;
        document.getElementById(tileId)?.remove();
        remoteUsers.delete(String(uid));
        if (!remoteUsers.size) remoteEmpty.classList.remove('hidden');
    }

    function ensureRemoteTile(uid) {
        const key = String(uid);
        let tile = remoteUsers.get(key);
        if (tile) return tile;
        const safeUid = key.replace(/[^0-9]/g, '');
        const article = document.createElement('section');
        article.className = 'tile';
        article.id = `remote-tile-${safeUid}`;
        const player = document.createElement('div');
        player.id = `remote-player-${safeUid}`;
        player.className = 'placeholder';
        player.textContent = 'Connecting participant…';
        const label = document.createElement('span');
        label.className = 'tile-label';
        label.textContent = 'Group member';
        article.append(player, label);
        remoteGrid.appendChild(article);
        remoteGrid.classList.remove('hidden');
        remoteEmpty.classList.add('hidden');
        tile = { article, player };
        remoteUsers.set(key, tile);
        return tile;
    }

    async function onUserPublished(remoteUser, mediaType) {
        await rtcClient.subscribe(remoteUser, mediaType);
        const tile = ensureRemoteTile(remoteUser.uid);
        if (mediaType === 'video' && remoteUser.videoTrack) {
            tile.player.replaceChildren();
            remoteUser.videoTrack.play(tile.player);
        }
        if (mediaType === 'audio' && remoteUser.audioTrack) remoteUser.audioTrack.play();
    }

    async function renewToken() {
        if (!joined || renewing || terminal) return;
        renewing = true;
        try {
            const fresh = await getCallAuthorization();
            if (fresh.appId !== credentials.appId || fresh.channelName !== credentials.channelName || fresh.uid !== credentials.uid) {
                throw new Error('Group-call identity changed during token renewal.');
            }
            await rtcClient.renewToken(fresh.token);
            credentials = fresh;
        } catch (error) {
            console.error('Group-call token renewal failed:', error);
            showError('Your call authorization could not be renewed. Please leave and rejoin if the session is still active.');
        } finally { renewing = false; }
    }

    async function startCall() {
        if (joined || joining || terminal) return;
        joining = true;
        showStatus('Requesting camera and microphone access…');
        try {
            if (!window.AgoraRTC) throw new Error('Agora video service did not load.');
            credentials = await getCallAuthorization();
            rtcClient = AgoraRTC.createClient({ mode: 'rtc', codec: 'vp8' });
            rtcClient.on('user-published', onUserPublished);
            rtcClient.on('user-unpublished', (user, mediaType) => {
                if (mediaType === 'video') {
                    const tile = remoteUsers.get(String(user.uid));
                    if (tile) tile.player.textContent = 'Camera is off';
                }
            });
            rtcClient.on('user-left', user => removeRemoteUser(user.uid));
            rtcClient.on('token-privilege-will-expire', () => void renewToken());
            rtcClient.on('connection-state-change', state => {
                if (state === 'DISCONNECTED' && !terminal) showStatus('Connection lost. Checking call availability…');
                else if (state === 'CONNECTED') showStatus('Connected to the group call.');
            });

            await rtcClient.join(credentials.appId, credentials.channelName, credentials.token, credentials.uid);
            joined = true;
            audioTrack = await AgoraRTC.createMicrophoneAudioTrack();
            videoTrack = await AgoraRTC.createCameraVideoTrack();
            localPlayer.replaceChildren();
            videoTrack.play(localPlayer);
            await rtcClient.publish([audioTrack, videoTrack]);
            micButton.disabled = false;
            cameraButton.disabled = false;
            showStatus('You are in the group call. Waiting for other members…');
            if (Number(credentials.callExpiresAt) > 0) {
                expiryTimer = window.setTimeout(() => {
                    showStatus('The group call session has expired.');
                    void finishLocal('This group call has expired.');
                }, Math.max(1000, Number(credentials.callExpiresAt) * 1000 - Date.now()));
            }
        } catch (error) {
            console.error('Group call startup failed:', error);
            await releaseMedia();
            showError(error.message || 'Unable to join the group call.');
        } finally { joining = false; }
    }

    async function finishLocal(message) {
        if (terminal) return;
        terminal = true;
        if (expiryTimer) clearTimeout(expiryTimer);
        if (sessionChannel) { try { await client.removeChannel(sessionChannel); } catch (_) {} sessionChannel = null; }
        await releaseMedia();
        if (message) showStatus(message);
        leaveButton.textContent = 'Return to Group Chat';
        endButton.classList.add('hidden');
    }

    async function leaveCall() {
        if (!session?.group_id) {
            window.location.replace('groups.html');
            return;
        }
        if (!terminal) await finishLocal('You left the group call.');
        window.location.replace(`group-chat.html?groupId=${encodeURIComponent(session.group_id)}`);
    }

    async function endCallForEveryone() {
        if (ending || terminal) return;
        ending = true;
        endButton.disabled = true;
        try {
            const { error } = await client.rpc('end_group_video_call', { p_session_id: sessionId });
            if (error) throw error;
            await finishLocal('The group call has ended for everyone.');
        } catch (error) {
            console.error('Unable to end group call:', error);
            showError(error.message || 'Unable to end the group call.');
        } finally { ending = false; endButton.disabled = false; }
    }

    function subscribeToSession() {
        sessionChannel = client.channel(`group-call-session-${sessionId}`)
            .on('postgres_changes', {
                event: 'UPDATE', schema: 'public', table: 'group_video_call_sessions', filter: `id=eq.${sessionId}`
            }, payload => {
                const fresh = payload.new;
                if (['ended', 'expired'].includes(fresh?.status)) {
                    void finishLocal(fresh.status === 'ended' ? 'The group call was ended by its host.' : 'The group call expired.');
                }
            })
            .subscribe();
    }

    async function initialize() {
        try {
            if (!UUID.test(sessionId || '')) throw new Error('A valid group-call session ID is required.');
            if (!client) throw new Error('The Staging Supabase client is unavailable.');
            const { data: authData, error: authError } = await client.auth.getUser();
            if (authError || !authData?.user) { window.location.replace('login.html'); return; }
            currentUser = authData.user;

            const { data: sessionRow, error: sessionError } = await client
                .from('group_video_call_sessions')
                .select('id, group_id, church_id, created_by, status, expires_at')
                .eq('id', sessionId)
                .maybeSingle();
            if (sessionError || !sessionRow) throw new Error('This group call was not found or you do not have access.');
            if (sessionRow.status !== 'active' || Date.parse(sessionRow.expires_at) <= Date.now()) {
                throw new Error('This group call has expired or has already ended.');
            }
            session = sessionRow;

            const { data: group, error: groupError } = await client
                .from('groups').select('name').eq('id', session.group_id).maybeSingle();
            if (groupError || !group) throw new Error('The group for this call could not be loaded.');
            groupNameEl.textContent = group.name || 'Group Video Call';
            document.title = `${group.name || 'Group'} Video Call | BelieversMeet`;
            document.getElementById('back-link').href = `group-chat.html?groupId=${encodeURIComponent(session.group_id)}`;

            if (session.created_by === currentUser.id) endButton.classList.remove('hidden');
            subscribeToSession();
            await startCall();
        } catch (error) {
            console.error('Group call initialization failed:', error);
            showError(error.message || 'Unable to initialize this group call.');
            micButton.disabled = true;
            cameraButton.disabled = true;
        }
    }

    micButton.addEventListener('click', async () => {
        if (!audioTrack || !joined) return;
        muted = !muted;
        await audioTrack.setEnabled(!muted);
        micButton.textContent = muted ? 'Unmute microphone' : 'Mute microphone';
    });
    cameraButton.addEventListener('click', async () => {
        if (!videoTrack || !joined) return;
        cameraOff = !cameraOff;
        await videoTrack.setEnabled(!cameraOff);
        cameraButton.textContent = cameraOff ? 'Turn camera on' : 'Turn camera off';
    });
    leaveButton.addEventListener('click', () => void leaveCall());
    endButton.addEventListener('click', () => void endCallForEveryone());

    void initialize();
    window.addEventListener('beforeunload', () => {
        if (expiryTimer) clearTimeout(expiryTimer);
        try { audioTrack?.close(); } catch (_) {}
        try { videoTrack?.close(); } catch (_) {}
        if (rtcClient && joined) void rtcClient.leave();
    });
})();
