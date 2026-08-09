import { useEffect, useRef, useState } from 'react';
import {
  ChevronDown, ChevronLeft, ChevronRight, Clapperboard, Download, Film, Loader2,
  Mic, MicOff, Sparkles, Upload, UploadCloud, X,
} from 'lucide-react';
import { mediaUrl } from '../../api/client.js';
import { resolveAnimateImage } from '../../lib/scenes.js';
import CopyButton from './CopyButton.jsx';
import ModelPicker from './ModelPicker.jsx';
import TranslateButton from './TranslateButton.jsx';
import VideoCarousel from './VideoCarousel.jsx';
import { sortByUseCount } from '../../lib/wishes.js';

const RESOLUTIONS = ['720p', '1080p'];
const ASPECT_RATIOS = ['auto', '1:1', '16:9', '9:16'];

/** `12с` / `1м 05с` - same shared unit labels ScenesStage.jsx/SunoStage.jsx
 * each keep their own local copy of. */
function formatDuration(totalSeconds, L) {
  const s = Math.max(0, Math.round(totalSeconds));
  if (s < 60) return `${s}${L.suno_unitSeconds}`;
  const m = Math.floor(s / 60);
  const rem = String(s % 60).padStart(2, '0');
  return `${m}${L.suno_unitMinutes} ${rem}${L.suno_unitSeconds}`;
}

function DebugPanel({ L, lastDebug }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="glass-card" style={{ marginBottom: 16 }}>
      <div
        className="suno-panel-title"
        style={{ marginBottom: open ? 12 : 0, cursor: 'pointer', justifyContent: 'space-between' }}
        onClick={() => setOpen((o) => !o)}
      >
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {open ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
          {L.video_debugTitle}
        </span>
      </div>
      {open && (
        !lastDebug ? (
          <div style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.scene_debugNoData}</div>
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{L.scene_debugRequestLabel}</div>
            <pre
              style={{
                margin: 0, marginBottom: 12, fontFamily: "'SF Mono',monospace", fontSize: 11.5,
                color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.6, maxHeight: 320, overflowY: 'auto',
              }}
            >
              {JSON.stringify(lastDebug.request, null, 2)}
            </pre>
            <div style={{ fontSize: 11, color: 'var(--text-faint)', marginBottom: 6 }}>{L.scene_debugResponseLabel}</div>
            <pre
              style={{
                margin: 0, fontFamily: "'SF Mono',monospace", fontSize: 11.5,
                color: 'rgba(255,255,255,0.75)', whiteSpace: 'pre-wrap', wordBreak: 'break-word',
                lineHeight: 1.6, maxHeight: 320, overflowY: 'auto',
              }}
            >
              {JSON.stringify(lastDebug.response, null, 2)}
            </pre>
          </>
        )
      )}
    </div>
  );
}

/** Video (animation) stage - the last step: walks scene-by-scene (prev/next
 * + a jump strip, unlike every other stage's scrollable list-of-cards
 * layout - see useVideoStage.js's docstring for why) sending an image from
 * the scene's `images[]` (its `animate_image_id` override if the user
 * clicked a different thumbnail here, else the Images stage's `is_selected`
 * pick - see `lib/scenes.js`'s `resolveAnimateImage`) plus its
 * `motion_prompt` (edited here, shared field with Scenes/Images) to an
 * image-to-video model. `videos[]` accumulates per scene like `images[]`
 * does - VideoCarousel.jsx pages through them, plus a plain file upload for
 * a clip animated in an outside tool and brought back in by hand. */
export default function VideoStage({
  L, project, isMobile,
  currentSceneIndex, videoModel, resolution, aspectRatio, durationSeconds,
  videoWishText, wishLoading, videoLoading, lastDebug, videoError, elapsedSeconds,
  videoModelFavorites, modelPrices, videoWishLibrary,
  isRecordingVideoWish, recordingSeconds, voiceSupported,
  actions,
}) {
  const scenes = project.scenes || [];
  const scene = scenes[currentSceneIndex];
  const activeWishIds = project.active_video_wish_ids || [];
  const videos = scene?.videos || [];

  const [videoIndex, setVideoIndex] = useState(Math.max(0, videos.length - 1));
  const prevLengthRef = useRef(videos.length);
  useEffect(() => {
    setVideoIndex(Math.max(0, (scene?.videos?.length || 0) - 1));
    prevLengthRef.current = scene?.videos?.length || 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentSceneIndex]);
  useEffect(() => {
    if (videos.length > prevLengthRef.current) setVideoIndex(videos.length - 1);
    prevLengthRef.current = videos.length;
  }, [videos.length]);

  const [imageUploadOpen, setImageUploadOpen] = useState(false);
  const [imageUploadUrl, setImageUploadUrl] = useState('');
  const imageFileInputRef = useRef(null);
  const videoFileInputRef = useRef(null);

  function submitImageUrl() {
    const url = imageUploadUrl.trim();
    if (!url) return;
    actions.onUploadImageUrl(currentSceneIndex, url);
    setImageUploadUrl('');
    setImageUploadOpen(false);
  }

  if (!scenes.length) {
    return (
      <>
        <div className="stage-heading">
          <div>
            <div className="stage-heading-title">{L.videoStageTitle}</div>
            <div className="stage-heading-subtitle">{L.videoStageSubtitle}</div>
          </div>
        </div>
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>{L.noStoryboardYet}</div>
      </>
    );
  }

  const sceneImages = scene.images || [];
  const animateImage = resolveAnimateImage(scene);
  const boundedVideoIndex = Math.min(videoIndex, Math.max(0, videos.length - 1));

  return (
    <>
      <div className="stage-heading">
        <div>
          <div className="stage-heading-title">{L.videoStageTitle}</div>
          <div className="stage-heading-subtitle">{L.videoStageSubtitle}</div>
        </div>
      </div>

      <div className="glass-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <button className="icon-btn" style={{ width: 30, height: 30 }} onClick={actions.goPrevScene} disabled={currentSceneIndex === 0}>
            <ChevronLeft size={15} />
          </button>
          <span style={{ fontSize: 13, color: 'var(--text-dim)' }}>
            {L.video_sceneOf.replace('{n}', currentSceneIndex + 1).replace('{total}', scenes.length)}
          </span>
          <button
            className="icon-btn" style={{ width: 30, height: 30 }}
            onClick={actions.goNextScene} disabled={currentSceneIndex === scenes.length - 1}
          >
            <ChevronRight size={15} />
          </button>
        </div>
        <div className="scene-thumb-strip">
          {scenes.map((s, i) => {
            const thumb = (s.images || []).find((img) => img.is_selected) || s.images?.[0];
            return (
              <button
                key={i}
                className={`scene-thumb${i === currentSceneIndex ? ' is-active' : ''}`}
                title={`${i + 1}. ${s.scene_description || s.lyric_segment || ''}`}
                onClick={() => actions.goToScene(i)}
              >
                {thumb ? (
                  <img src={mediaUrl(`projects/${project.id}/${thumb.file_path}`)} alt="" />
                ) : (
                  <Clapperboard size={14} color="rgba(255,255,255,0.35)" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      <div className="scene-row">
        <div className="glass-card scene-card">
          <div className="scene-card-header">
            <span className="scene-number">{currentSceneIndex + 1}</span>
            <div>
              {scene.scene_description && <div className="scene-description">{scene.scene_description}</div>}
              <span className="scene-lyric-segment">{scene.lyric_segment}</span>
            </div>
          </div>

          <div>
            <div className="scene-prompt-label">
              <Film size={12} />
              {L.motionPrompt}
            </div>
            <textarea
              className="scene-textarea"
              value={scene.motion_prompt || ''}
              onChange={(e) => actions.onMotionChange(e.target.value)}
            />
            <div className="scene-field-actions">
              <TranslateButton L={L} text={scene.motion_prompt} />
              <CopyButton L={L} text={scene.motion_prompt} />
            </div>
          </div>

          <div className="scene-actions">
            <div className="scene-actions-left" />
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                className="btn btn-accent-soft" style={{ padding: '7px 12px', fontSize: 12.5 }}
                onClick={() => setImageUploadOpen((o) => !o)}
              >
                <Upload size={13} />
                {L.uploadSceneImage}
              </button>
            </div>
          </div>

          {imageUploadOpen && (
            <div className="scene-upload-panel">
              <button className="btn btn-accent-soft" style={{ padding: '6px 11px', fontSize: 12 }} onClick={() => imageFileInputRef.current?.click()}>
                {L.uploadFromFile}
              </button>
              <input
                ref={imageFileInputRef}
                type="file"
                accept="image/*"
                style={{ display: 'none' }}
                onChange={(e) => {
                  const file = e.target.files?.[0];
                  if (file) actions.onUploadImageFile(currentSceneIndex, file);
                  e.target.value = '';
                  setImageUploadOpen(false);
                }}
              />
              <input
                className="field"
                style={{ flex: 1, minWidth: 160 }}
                value={imageUploadUrl}
                onChange={(e) => setImageUploadUrl(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') submitImageUrl(); }}
                placeholder={L.uploadFromUrlPlaceholder}
              />
              <button className="btn btn-accent-soft" style={{ padding: '6px 11px', fontSize: 12 }} onClick={submitImageUrl} disabled={!imageUploadUrl.trim()}>
                {L.uploadFromUrlAction}
              </button>
            </div>
          )}

          {sceneImages.length === 0 ? (
            <div style={{ fontSize: 12.5, color: '#fbbf24', marginTop: 10 }}>⚠️ {L.video_noSelectedImage}</div>
          ) : (
            <div className="scene-thumb-strip">
              {sceneImages.map((img) => (
                <button
                  key={img.image_id}
                  className={`scene-thumb${img.image_id === animateImage?.image_id ? ' is-active' : ''}`}
                  title={L.video_pickImageTitle}
                  onClick={() => actions.onSelectAnimateImage(currentSceneIndex, img.image_id)}
                >
                  <img src={mediaUrl(`projects/${project.id}/${img.file_path}`)} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>

        <div className="glass-card scene-image-panel">
          {animateImage ? (
            <div className="image-carousel is-fill">
              <div className="image-carousel-frame">
                <img src={mediaUrl(`projects/${project.id}/${animateImage.file_path}`)} alt="" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                <a
                  className="image-carousel-download-btn"
                  href={mediaUrl(`projects/${project.id}/${animateImage.file_path}`)}
                  download
                  title={L.video_downloadImageTitle}
                >
                  <Download size={13} />
                </a>
              </div>
            </div>
          ) : (
            <div className="image-carousel is-fill">
              <div className="image-carousel-frame">
                <span className="image-carousel-placeholder">{L.video_noSelectedImage}</span>
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="glass-card" style={{ marginTop: 18, marginBottom: 16 }}>
        <div className="suno-panel-title">
          <Sparkles size={16} color="#ff9d5c" />
          {L.video_wishesTitle}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
          <input
            className="field"
            value={videoWishText}
            onChange={(e) => actions.setVideoWishText(e.target.value)}
            placeholder={isRecordingVideoWish ? L.listening : L.video_wishPlaceholder}
          />
          {voiceSupported && (
            <button
              className={`icon-btn${isRecordingVideoWish ? ' icon-btn-recording' : ''}`}
              style={{ width: 38, height: 38 }}
              onClick={() => actions.startVoice('videoWish')}
            >
              {isRecordingVideoWish ? <MicOff size={15} /> : <Mic size={15} />}
            </button>
          )}
          <button
            className="btn btn-accent-soft" style={{ flexShrink: 0 }}
            onClick={actions.addVideoWish} disabled={wishLoading}
          >
            {wishLoading ? <Loader2 size={14} className="spin" /> : null}
            {L.apply}
          </button>
        </div>
        {isRecordingVideoWish && (
          <div className="recording-banner" style={{ marginTop: 10 }}>
            <span className="recording-dot" />
            {L.recording} · {recordingSeconds}s
          </div>
        )}
        {!!videoWishLibrary?.length && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            {sortByUseCount(videoWishLibrary).map((wish) => (
              <span key={wish.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                <button
                  className={`chip${activeWishIds.includes(wish.id) ? ' is-active' : ''}`}
                  title={wish.text}
                  onClick={() => actions.toggleVideoWish(wish.id)}
                >
                  {wish.title}
                </button>
                <button
                  className="icon-btn" style={{ width: 20, height: 20 }}
                  title={L.wish_deleteTitle}
                  onClick={() => actions.onDeleteVideoWish(wish.id)}
                >
                  <X size={10} />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.video_resolutionLabel}:</span>
        {RESOLUTIONS.map((r) => (
          <button key={r} className={`chip${resolution === r ? ' is-active' : ''}`} onClick={() => actions.setResolution(r)}>{r}</button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 10 }}>{L.video_aspectRatioLabel}:</span>
        {ASPECT_RATIOS.map((r) => (
          <button key={r} className={`chip${aspectRatio === r ? ' is-active' : ''}`} onClick={() => actions.setAspectRatio(r)}>
            {r === 'auto' ? L.aspectRatio_auto : r}
          </button>
        ))}
        <span style={{ fontSize: 12, color: 'var(--text-dim)', marginLeft: 10 }}>{L.video_durationLabel}:</span>
        <input
          type="number" min={1} max={8} className="field" style={{ width: 60 }}
          value={durationSeconds}
          onChange={(e) => actions.setDurationSeconds(Math.max(1, Math.min(8, Number(e.target.value) || 1)))}
        />
      </div>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 12, flexWrap: 'wrap' }}>
        <button
          className="btn btn-gradient" style={{ padding: '12px 20px', fontSize: 14 }}
          onClick={actions.generateVideo} disabled={videoLoading}
        >
          {videoLoading ? <Loader2 size={16} className="spin" /> : <Film size={16} />}
          {videoLoading ? L.video_generating : videos.length ? L.video_generateAnother : L.video_generate}
        </button>
        <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>{L.video_modelLabel}:</span>
        <ModelPicker
          favorites={videoModelFavorites}
          value={videoModel}
          onChange={actions.selectVideoModel}
          emptyLabel={L.modelPickerEmpty}
          prices={modelPrices}
          L={L}
        />
        <button
          className="btn btn-accent-soft" style={{ padding: '10px 16px', fontSize: 13 }}
          onClick={() => videoFileInputRef.current?.click()}
        >
          <UploadCloud size={14} />
          {L.video_uploadVideoButton}
        </button>
        <input
          ref={videoFileInputRef}
          type="file"
          accept="video/*"
          style={{ display: 'none' }}
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) actions.onUploadVideoFile(currentSceneIndex, file);
            e.target.value = '';
          }}
        />
      </div>

      {videoLoading && (
        <div style={{ fontSize: 13, color: 'var(--text-dim)', marginBottom: 16 }}>
          ⏳ {L.video_generating} · {formatDuration(elapsedSeconds, L)}
        </div>
      )}
      {!videoLoading && videoError && (
        <div style={{ fontSize: 13, color: '#fca5a5', marginBottom: 16 }}>⚠️ {videoError}</div>
      )}

      <DebugPanel L={L} lastDebug={lastDebug} />

      {videos.length === 0 ? (
        <div className="glass-card" style={{ color: 'var(--text-dim)', fontSize: 13 }}>{L.video_noneYet}</div>
      ) : (
        <div className="glass-card scene-image-panel" style={{ maxWidth: isMobile ? '100%' : 520 }}>
          <VideoCarousel
            L={L} projectId={project.id} videos={videos} currentIndex={boundedVideoIndex}
            onIndexChange={setVideoIndex}
            onDelete={() => actions.onDelete(currentSceneIndex, boundedVideoIndex)}
            onSelectMain={() => actions.onSelectMain(currentSceneIndex, boundedVideoIndex)}
            onRate={(rating) => actions.onRate(currentSceneIndex, boundedVideoIndex, rating)}
          />
        </div>
      )}
    </>
  );
}
