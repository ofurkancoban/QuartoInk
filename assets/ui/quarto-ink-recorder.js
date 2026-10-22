/*
 * Quarto Ink: record the lecture (slides, ink and the microphone) into a video file.
 *
 * The deck runs in a sandboxed frame whose pixels a page cannot read, so the recording uses
 * the browser's screen capture: this tab is offered first and, where the browser supports
 * Region Capture (Chrome), the video is cropped to the slide area. The microphone is added
 * when allowed. Everything stays in the browser; stopping saves the file.
 */
(function () {
    'use strict';

    const TYPES = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];

    let recorder = null;
    let streams = [];
    let chunks = [];
    let startedAt = 0;
    let clock = null;

    const isRecording = () => !!recorder && recorder.state !== 'inactive';

    function syncButton() {
        const btn = document.getElementById('btn-record');
        if (!btn) return;
        const on = isRecording();
        btn.classList.toggle('recording', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.title = on ? 'Stop recording and save the video' : 'Record the lecture (slides, ink and microphone)';
        const time = btn.querySelector('.qi-record-time');
        if (time) time.textContent = on ? formatTime(performance.now() - startedAt) : '';
    }

    function formatTime(ms) {
        const s = Math.floor(ms / 1000);
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
    }

    function setStatus(text) {
        const el = document.getElementById('status-left');
        if (el) el.textContent = text;
    }

    function stopTracks() {
        streams.forEach((stream) => stream.getTracks().forEach((t) => t.stop()));
        streams = [];
    }

    async function start() {
        if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function' || typeof MediaRecorder === 'undefined') {
            qiAlert('Recording not available', 'This browser cannot record the screen. Try a current Chrome, Edge or Safari.');
            return;
        }
        let screen;
        try {
            screen = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 30 },
                audio: false,
                preferCurrentTab: true,
                selfBrowserSurface: 'include',
            });
        } catch (_e) {
            setStatus('Recording cancelled');
            return;
        }
        streams = [screen];
        const video = screen.getVideoTracks()[0];

        // Only the slide area, where the browser can crop to an element (Chrome's Region Capture).
        const stage = document.getElementById('editor-stage');
        if (stage && video && typeof video.cropTo === 'function' && window.CropTarget) {
            try {
                await video.cropTo(await window.CropTarget.fromElement(stage));
            } catch (_e) {}
        }

        const tracks = [video];
        try {
            const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
            streams.push(mic);
            tracks.push(...mic.getAudioTracks());
        } catch (_e) {
            setStatus('Recording without the microphone (not allowed)');
        }

        const mimeType = TYPES.find((t) => MediaRecorder.isTypeSupported(t)) || '';
        chunks = [];
        recorder = new MediaRecorder(new MediaStream(tracks), mimeType ? { mimeType, videoBitsPerSecond: 4000000 } : undefined);
        recorder.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
        recorder.onstop = save;
        // Ending the screen share from the browser's own bar stops the recording too.
        video.addEventListener('ended', stop);
        recorder.start(1000);
        startedAt = performance.now();
        clock = setInterval(syncButton, 500);
        syncButton();
        setStatus('Recording...');
    }

    function stop() {
        if (isRecording()) recorder.stop();
    }

    function save() {
        clearInterval(clock);
        clock = null;
        stopTracks();
        const type = (recorder && recorder.mimeType) || 'video/webm';
        recorder = null;
        syncButton();
        if (!chunks.length) {
            setStatus('Nothing was recorded');
            return;
        }
        const blob = new Blob(chunks, { type: type.split(';')[0] });
        chunks = [];
        const ext = /mp4/.test(type) ? 'mp4' : 'webm';
        const name = (state.currentFileName || 'lecture').replace(/\.html?$/i, '').replace(/[\\/:*?"<>|]+/g, '_');
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `${name}-recording.${ext}`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        setStatus('Saved the recording');
    }

    function toggle() {
        if (isRecording()) stop();
        else void start();
    }

    function init() {
        const btn = document.getElementById('btn-record');
        if (btn) btn.addEventListener('click', toggle);
        syncButton();
    }

    window.QuartoInkRecorder = { start, stop, toggle, isRecording };

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
