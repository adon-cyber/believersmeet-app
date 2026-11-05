/**
 * BelieversMeet one-to-one video-call invitations.
 * believersmeet-invitation-listener
 * Incoming calls use authorized RPCs and Postgres Changes.
 */
(() => {
    'use strict';

    if (window.__believersMeetInvitationListenerInstalled) return;

    const UUID_PATTERN =
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

    const processedInvitations = new Set();

    async function waitForChatContext() {
        for (let attempt = 0; attempt < 100; attempt++) {
            const client = window.sbClient || window.supabaseClient;
            const user = window.believersMeetCurrentUser;

            if (client && user?.id && typeof client.rpc === 'function') {
                return { client, user };
            }

            await new Promise(resolve => setTimeout(resolve, 150));
        }

        console.error('Video-call listener: authenticated chat context unavailable.');
        return null;
    }

    async function getCallerName(client, callerId) {
        try {
            const { data, error } = await client
                .from('profiles')
                .select('full_name')
                .eq('id', callerId)
                .maybeSingle();

            if (error) throw error;
            return data?.full_name || 'a member';
        } catch (error) {
            console.warn('Could not retrieve caller name:', error);
            return 'a member';
        }
    }

    async function handleIncomingInvitation(client, userId, invitation) {
        if (
            !invitation ||
            !UUID_PATTERN.test(invitation.id || '') ||
            invitation.recipient_id !== userId ||
            invitation.status !== 'ringing' ||
            processedInvitations.has(invitation.id)
        ) {
            return;
        }

        const expiresAt = Date.parse(invitation.expires_at || '');

        if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
            return;
        }

        processedInvitations.add(invitation.id);

        try {
            const callerName = await getCallerName(
                client,
                invitation.caller_id
            );

            if (Date.now() >= expiresAt) return;

            const accepted = window.confirm(
                `Incoming video call from ${callerName}. Accept?`
            );

            const { data: responseStatus, error } = await client.rpc(
                'respond_to_video_call_invitation',
                {
                    p_invitation_id: invitation.id,
                    p_action: accepted ? 'accepted' : 'declined'
                }
            );

            if (error) throw error;

            if (accepted && responseStatus === 'accepted') {
                window.location.assign(
                    `video-call.html?invitation=${encodeURIComponent(invitation.id)}`
                );
                return;
            }

            if (responseStatus === 'expired') {
                alert('This video-call invitation has expired.');
            } else if (responseStatus === 'cancelled') {
                alert('This video-call invitation is no longer available.');
            } else if (accepted && responseStatus !== 'accepted') {
                alert('The video-call invitation could not be accepted.');
            }
        } catch (error) {
            console.error('Unable to respond to video-call invitation:', error);
            alert(
                error.message ||
                'Could not process the video-call invitation. Please try again.'
            );
        }
    }

    async function loadPendingInvitations(client, userId) {
        try {
            const { data, error } = await client
                .from('video_call_invitations')
                .select('id, caller_id, recipient_id, status, expires_at')
                .eq('recipient_id', userId)
                .eq('status', 'ringing')
                .gt('expires_at', new Date().toISOString())
                .order('created_at', { ascending: false });

            if (error) throw error;

            for (const invitation of data || []) {
                await handleIncomingInvitation(client, userId, invitation);
            }
        } catch (error) {
            console.error('Could not load pending video-call invitations:', error);
        }
    }

    async function startInvitationListener() {
        const context = await waitForChatContext();

        if (!context) {
            window.__believersMeetInvitationListenerInstalled = false;
            return;
        }

        const { client, user } = context;
        const userId = user.id;
        let pendingLoaded = false;

        const channel = client
            .channel(`video-call-invitations-recipient-${userId}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'video_call_invitations',
                    filter: `recipient_id=eq.${userId}`
                },
                payload => {
                    void handleIncomingInvitation(client, userId, payload.new);
                }
            )
            .subscribe(status => {
                if (status === 'SUBSCRIBED' && !pendingLoaded) {
                    pendingLoaded = true;
                    void loadPendingInvitations(client, userId);
                }

                if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
                    console.error('Video-call invitation subscription problem:', status);
                }
            });

        window.addEventListener('pagehide', () => {
            void client.removeChannel(channel);
        });

        console.log('BelieversMeet invitation listener initialized.');
    }

    window.__believersMeetInvitationListenerInstalled = true;
    void startInvitationListener();
})();