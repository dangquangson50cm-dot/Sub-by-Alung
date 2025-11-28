import React, { useState, useRef, useEffect } from 'react';
import { Play, Pause, Plus, Download, ZoomIn, ZoomOut, Upload, Trash2, Edit2, Video, X, Waves, Volume2, VolumeX, CheckCircle, Settings, Type } from 'lucide-react';
import { WaveformEditor } from './components/WaveformEditor';
import { generateSRT, formatTime } from './utils/srt';
import { Subtitle, SubtitleStyle } from './types';

// Default Styles
const DEFAULT_STYLE: SubtitleStyle = {
  fontFamily: 'Arial',
  fontSize: 5, // 5% of video height
  strokeWidth: 15, // 15% of font size
  fontWeight: 'bold', // 'normal' | 'bold' | '900'
  color: '#FFFFFF'
};

const FONT_OPTIONS = [
  'Arial', 'Calibri', 'Times New Roman', 'Courier New', 'Verdana', 'Roboto', 'Georgia', 'Trebuchet MS', 'Impact', 'Comic Sans MS'
];

const WEIGHT_OPTIONS = [
  { label: 'Normal', value: 'normal' },
  { label: 'Bold', value: 'bold' },
  { label: 'Heavy', value: '900' },
];

const App: React.FC = () => {
  // --- State ---
  const [videoSrc, setVideoSrc] = useState<string | null>(null);
  const [audioBuffer, setAudioBuffer] = useState<AudioBuffer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [isLoadingAudio, setIsLoadingAudio] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  
  const [subtitles, setSubtitles] = useState<Subtitle[]>([]);
  const [selectedSubId, setSelectedSubId] = useState<string | null>(null);
  
  // View State
  const [zoomLevel, setZoomLevel] = useState(50); // pixels per second
  const [textEditText, setTextEditText] = useState("");

  // Styling State
  const [style, setStyle] = useState<SubtitleStyle>(DEFAULT_STYLE);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [videoDimensions, setVideoDimensions] = useState({ width: 0, height: 0 });

  // Export State
  const [isExportingVideo, setIsExportingVideo] = useState(false);
  const [renderStatus, setRenderStatus] = useState<'idle' | 'rendering' | 'completed'>('idle');
  const [exportProgress, setExportProgress] = useState(0);
  const [mutePreview, setMutePreview] = useState(true);

  // Refs
  const videoRef = useRef<HTMLVideoElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const renderCanvasRef = useRef<HTMLCanvasElement>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const renderLoopIdRef = useRef<number>(0); // Store generic ID for rAF or rVFC
  const previousVolumeRef = useRef<number>(1);
  const styleRef = useRef(style); // Ref to access latest style in loops
  
  // Overlay Refs (Direct DOM manipulation for performance)
  const subtitleOverlayRef = useRef<HTMLDivElement>(null);
  const subtitlesRef = useRef<Subtitle[]>([]); // Mirror state for the loop

  // --- Handlers ---

  const handleFileUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // 1. Set Video
    const url = URL.createObjectURL(file);
    setVideoSrc(url);
    setIsLoadingAudio(true);
    setSubtitles([]); 
    setSelectedSubId(null);

    // 2. Decode Audio for Waveform
    try {
      const arrayBuffer = await file.arrayBuffer();
      const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      const decodedBuffer = await audioContext.decodeAudioData(arrayBuffer);
      setAudioBuffer(decodedBuffer);
    } catch (err) {
      console.error("Error decoding audio", err);
      alert("Could not decode audio track. Waveform may not appear.");
    } finally {
      setIsLoadingAudio(false);
    }
  };

  const togglePlay = () => {
    if (!videoRef.current) return;
    if (isPlaying) {
      videoRef.current.pause();
    } else {
      videoRef.current.play();
    }
    setIsPlaying(!isPlaying);
  };

  const addSubtitle = () => {
    if (!videoRef.current) return;
    const start = videoRef.current.currentTime;
    const newSub: Subtitle = {
      id: crypto.randomUUID(),
      start: start,
      end: start + 2.0, // Default 2s duration
      text: "New Subtitle"
    };
    setSubtitles([...subtitles, newSub]);
    setSelectedSubId(newSub.id);
    setTextEditText("New Subtitle");
  };

  const deleteSubtitle = (id: string) => {
    setSubtitles(subtitles.filter(s => s.id !== id));
    if (selectedSubId === id) setSelectedSubId(null);
  };

  const exportSRT = () => {
    const content = generateSRT(subtitles);
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'subtitles.srt';
    a.click();
    URL.revokeObjectURL(url);
  };

  // --- Video Export (Burn-in) Logic ---
  
  const handleExportVideo = () => {
    if (!videoSrc) return;
    if (videoRef.current) {
        videoRef.current.pause();
        previousVolumeRef.current = videoRef.current.volume;
    }
    setIsExportingVideo(true);
    setRenderStatus('idle');
    setExportProgress(0);
  };

  const startRendering = () => {
    const video = videoRef.current;
    const canvas = renderCanvasRef.current;
    if (!video || !canvas || !videoSrc) return;

    setRenderStatus('rendering');
    video.currentTime = 0;
    
    // Handle Mute for Preview
    video.volume = mutePreview ? 0 : previousVolumeRef.current; 

    // Setup Canvas size
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d', { alpha: false }); // Optimize for no transparency
    if (!ctx) return;

    // --- Format Selection (Prioritize MP4) ---
    const mimeTypes = [
        'video/mp4;codecs=avc1.4d002a', // H.264 High Profile (Best for MP4)
        'video/mp4;codecs=avc1.42E01E', // H.264 Baseline
        'video/mp4',
        'video/webm;codecs=h264',
        'video/webm;codecs=vp9',
        'video/webm'
    ];

    let selectedMimeType = '';
    for (const type of mimeTypes) {
        if (MediaRecorder.isTypeSupported(type)) {
            selectedMimeType = type;
            break;
        }
    }

    if (!selectedMimeType) {
        alert("Your browser does not support video recording formats required for this feature.");
        setRenderStatus('idle');
        return;
    }
    
    // Determine extension based on selected mime type
    const fileExtension = selectedMimeType.includes('mp4') ? 'mp4' : 'webm';

    console.log(`Exporting using: ${selectedMimeType}`);

    // Capture Stream - 60 FPS for smoothness
    const canvasStream = canvas.captureStream(60);
    
    // Attempt Audio Capture
    let finalStream = canvasStream;
    try {
        // @ts-ignore
        if (video.captureStream) {
            // @ts-ignore
            const videoStream = video.captureStream();
            const audioTrack = videoStream.getAudioTracks()[0];
            if (audioTrack) finalStream.addTrack(audioTrack);
        } else if ((video as any).mozCaptureStream) {
             // @ts-ignore
            const videoStream = (video as any).mozCaptureStream();
            const audioTrack = videoStream.getAudioTracks()[0];
            if (audioTrack) finalStream.addTrack(audioTrack);
        }
    } catch (e) {
        console.warn("Could not capture audio track:", e);
    }

    const chunks: Blob[] = [];
    // Increase video bits per second for quality
    const recorder = new MediaRecorder(finalStream, { 
        mimeType: selectedMimeType,
        videoBitsPerSecond: 8000000 // 8 Mbps for high quality
    });

    recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunks.push(e.data);
    };

    recorder.onstop = () => {
        const blob = new Blob(chunks, { type: selectedMimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `avsub_export_${Date.now()}.${fileExtension}`;
        a.click();
        URL.revokeObjectURL(url);
        
        if (videoRef.current) {
            videoRef.current.pause();
            videoRef.current.volume = previousVolumeRef.current;
        }
        setRenderStatus('completed');
    };

    mediaRecorderRef.current = recorder;
    recorder.start();

    // --- Render Function ---
    const renderFrame = () => {
        if (video.ended || video.paused) {
             if (video.ended) {
                 recorder.stop();
                 return;
             }
        }

        // Draw Video Frame
        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        // Find Active Subtitle
        const activeSub = subtitlesRef.current.find(s => 
            video.currentTime >= s.start && video.currentTime <= s.end
        );

        // Draw Subtitle Text
        if (activeSub) {
            const currentStyle = styleRef.current;
            const fontSize = Math.floor(canvas.height * (currentStyle.fontSize / 100));
            
            ctx.font = `${currentStyle.fontWeight} ${fontSize}px "${currentStyle.fontFamily}", sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'bottom';
            ctx.lineJoin = 'round';
            ctx.miterLimit = 2;

            const strokeRatio = currentStyle.strokeWidth / 100;
            ctx.lineWidth = fontSize * strokeRatio; 

            const x = canvas.width / 2;
            const y = canvas.height - (fontSize * 1.5);

            // Stroke
            if (ctx.lineWidth > 0) {
              ctx.strokeStyle = 'black';
              ctx.strokeText(activeSub.text, x, y);
            }

            // Fill
            ctx.fillStyle = currentStyle.color;
            ctx.fillText(activeSub.text, x, y);
        }

        setExportProgress((video.currentTime / video.duration) * 100);

        // Continue loop using requestVideoFrameCallback if available for perfect sync, otherwise rAF
        if ('requestVideoFrameCallback' in video) {
            renderLoopIdRef.current = video.requestVideoFrameCallback(renderFrame);
        } else {
            renderLoopIdRef.current = requestAnimationFrame(renderFrame);
        }
    };

    // Start Playback for recording
    video.play().then(() => {
        if ('requestVideoFrameCallback' in video) {
             renderLoopIdRef.current = video.requestVideoFrameCallback(renderFrame);
        } else {
             renderLoopIdRef.current = requestAnimationFrame(renderFrame);
        }
    }).catch(err => {
        console.error("Playback failed during export", err);
        setRenderStatus('idle');
    });
  };

  const closeExport = () => {
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          mediaRecorderRef.current.stop();
      }
      if (videoRef.current) {
          videoRef.current.pause();
          videoRef.current.volume = previousVolumeRef.current;
          // Cancel render loop
          if ('requestVideoFrameCallback' in videoRef.current) {
               videoRef.current.cancelVideoFrameCallback(renderLoopIdRef.current);
          } else {
               cancelAnimationFrame(renderLoopIdRef.current);
          }
      }
      
      setIsExportingVideo(false);
      setRenderStatus('idle');
  };


  // --- Effects ---

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const onTimeUpdate = () => setCurrentTime(video.currentTime);
    const onPlay = () => setIsPlaying(true);
    const onPause = () => setIsPlaying(false);
    const onLoadedMetadata = () => {
        setDuration(video.duration);
        setVideoDimensions({ width: video.videoWidth, height: video.videoHeight });
    };

    video.addEventListener('timeupdate', onTimeUpdate);
    video.addEventListener('play', onPlay);
    video.addEventListener('pause', onPause);
    video.addEventListener('loadedmetadata', onLoadedMetadata);

    const resizeObserver = new ResizeObserver(entries => {
        for (let entry of entries) {
            setVideoDimensions({ width: entry.contentRect.width, height: entry.contentRect.height });
        }
    });
    resizeObserver.observe(video);

    return () => {
      video.removeEventListener('timeupdate', onTimeUpdate);
      video.removeEventListener('play', onPlay);
      video.removeEventListener('pause', onPause);
      video.removeEventListener('loadedmetadata', onLoadedMetadata);
      resizeObserver.disconnect();
    };
  }, [videoSrc]);

  useEffect(() => {
    const sub = subtitles.find(s => s.id === selectedSubId);
    if (sub) setTextEditText(sub.text);
  }, [selectedSubId, subtitles]); 

  useEffect(() => {
      subtitlesRef.current = subtitles;
  }, [subtitles]);

  useEffect(() => {
      styleRef.current = style;
  }, [style]);

  // Real-time Overlay Animation Loop
  useEffect(() => {
    let animId: number;
    
    const updateOverlay = () => {
        const video = videoRef.current;
        const overlay = subtitleOverlayRef.current;

        if (video && overlay) {
            const time = video.currentTime;
            const currentSub = subtitlesRef.current.find(s => time >= s.start && time <= s.end);
            
            if (currentSub) {
                overlay.innerText = currentSub.text;
                overlay.style.display = 'block';
            } else {
                overlay.style.display = 'none';
            }
        }
        
        animId = requestAnimationFrame(updateOverlay);
    };

    updateOverlay();

    return () => cancelAnimationFrame(animId);
  }, []);

  const handleTextChange = (txt: string) => {
    setTextEditText(txt);
    setSubtitles(prev => prev.map(s => 
      s.id === selectedSubId ? { ...s, text: txt } : s
    ));
  };

  // Preview Style Calculation
  const previewFontSize = videoDimensions.height > 0 
    ? videoDimensions.height * (style.fontSize / 100) 
    : 24;
  
  // Calculate text stroke width relative to font size for CSS
  const previewStrokeWidth = (previewFontSize * (style.strokeWidth / 100)) / 2; // Divide by 2 as CSS stroke is centered/outer behavior differs from Canvas

  return (
    <div className="flex flex-col h-full bg-slate-950 text-slate-100 font-sans overflow-hidden">
      
      <canvas ref={renderCanvasRef} className="hidden" />

      {/* 1. TOP HEADER */}
      <div className="flex-none h-14 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-4 z-20 shadow-md">
        
        {/* LOGO & SETTINGS TOGGLE */}
        <button 
          onClick={() => setIsSettingsOpen(!isSettingsOpen)}
          className="flex items-center gap-2 font-black text-xl tracking-tighter text-cyan-400 select-none hover:text-cyan-300 transition-colors focus:outline-none"
        >
             <Waves className="w-6 h-6" />
             <span>AVSUB</span>
             <Settings className="w-4 h-4 text-slate-500 ml-1" />
        </button>
        
        <button 
            onClick={handleExportVideo} 
            disabled={!videoSrc || subtitles.length === 0 || isExportingVideo}
            className={`
                flex items-center gap-2 px-4 py-1.5 rounded-full text-xs font-bold uppercase tracking-wide transition-all
                ${!videoSrc || subtitles.length === 0 
                    ? 'bg-slate-800 text-slate-500 cursor-not-allowed' 
                    : 'bg-gradient-to-r from-cyan-600 to-blue-600 text-white hover:from-cyan-500 hover:to-blue-500 shadow-lg shadow-cyan-900/20 active:scale-95'
                }
            `}
        >
            <Video size={14} /> 
            <span>Burn Video</span>
        </button>
      </div>

      {/* SETTINGS POPOVER */}
      {isSettingsOpen && (
        <div 
          className="fixed inset-0 z-50 bg-black/50 backdrop-blur-sm"
          onClick={() => setIsSettingsOpen(false)}
        >
          <div 
            className="absolute top-16 left-4 w-72 bg-slate-900 border border-slate-700 rounded-xl shadow-2xl p-4 animate-in fade-in slide-in-from-top-4"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex justify-between items-center mb-4">
               <h3 className="text-sm font-bold text-white uppercase tracking-wider flex items-center gap-2">
                 <Type size={16} className="text-cyan-400" /> Style Settings
               </h3>
               <button onClick={() => setIsSettingsOpen(false)} className="text-slate-500 hover:text-white"><X size={16}/></button>
            </div>
            
            <div className="mb-4">
              <label className="text-xs text-slate-400 font-semibold mb-1 block">Font Family</label>
              <select 
                value={style.fontFamily} 
                onChange={e => setStyle({...style, fontFamily: e.target.value})}
                className="w-full bg-slate-950 border border-slate-700 rounded-md py-2 px-2 text-sm text-slate-200 focus:border-cyan-500 outline-none"
              >
                {FONT_OPTIONS.map(font => <option key={font} value={font}>{font}</option>)}
              </select>
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-xs text-slate-400 mb-1 font-semibold">
                <label>Size</label>
                <span>{style.fontSize}%</span>
              </div>
              <input 
                type="range" min="2" max="15" step="0.5" 
                value={style.fontSize} 
                onChange={e => setStyle({...style, fontSize: Number(e.target.value)})}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            <div className="mb-4">
              <div className="flex justify-between text-xs text-slate-400 mb-1 font-semibold">
                <label>Stroke Width</label>
                <span>{style.strokeWidth}</span>
              </div>
              <input 
                type="range" min="0" max="50" step="1" 
                value={style.strokeWidth} 
                onChange={e => setStyle({...style, strokeWidth: Number(e.target.value)})}
                className="w-full h-2 bg-slate-700 rounded-lg appearance-none cursor-pointer accent-cyan-500"
              />
            </div>

            <div className="mb-2">
              <label className="text-xs text-slate-400 font-semibold mb-2 block">Font Weight</label>
              <div className="flex bg-slate-950 p-1 rounded-lg border border-slate-800">
                {WEIGHT_OPTIONS.map(opt => (
                  <button
                    key={opt.value}
                    onClick={() => setStyle({...style, fontWeight: opt.value})}
                    className={`flex-1 py-1.5 text-xs rounded transition-colors ${style.fontWeight === opt.value ? 'bg-cyan-600 text-white font-bold' : 'text-slate-400 hover:text-slate-200'}`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* 2. Video Area */}
      <div className="flex-none bg-black relative group">
        {!videoSrc ? (
          <div className="aspect-video w-full flex flex-col items-center justify-center bg-slate-900 border-b border-gray-800">
             <button 
                onClick={() => fileInputRef.current?.click()}
                className="flex items-center gap-2 px-6 py-3 bg-slate-800 rounded-full font-semibold hover:bg-slate-700 active:scale-95 transition text-cyan-400 border border-slate-700"
             >
                <Upload size={20} />
                Load Video
             </button>
             <p className="mt-2 text-slate-500 text-sm">Select a video file to start</p>
          </div>
        ) : (
          <div className="relative mx-auto max-h-[40vh] w-full flex justify-center bg-black">
             <video 
                ref={videoRef}
                src={videoSrc}
                className="max-h-[40vh] max-w-full object-contain"
                playsInline
                onClick={togglePlay}
                crossOrigin="anonymous" 
              />
              {/* REAL-TIME SUBTITLE OVERLAY */}
              <div 
                ref={subtitleOverlayRef}
                className="absolute bottom-6 left-0 right-0 text-center pointer-events-none z-10 px-4"
                style={{
                    fontFamily: style.fontFamily,
                    fontWeight: style.fontWeight === '900' ? '900' : style.fontWeight === 'bold' ? 'bold' : 'normal',
                    fontSize: `${previewFontSize}px`,
                    color: style.color,
                    display: 'none',
                    lineHeight: '1.2',
                    // WebkitTextStroke provides a much more accurate preview of canvas stroke than text-shadow
                    WebkitTextStroke: `${previewStrokeWidth}px black`,
                    paintOrder: 'stroke fill'
                }}
              >
              </div>
          </div>
        )}
        <input 
          type="file" 
          accept="video/*" 
          className="hidden" 
          ref={fileInputRef} 
          onChange={handleFileUpload} 
        />
        
        {/* Loading Overlay */}
        {isLoadingAudio && (
            <div className="absolute inset-0 bg-black/70 flex items-center justify-center z-10">
                <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-cyan-400 mr-2"></div>
                <span>Processing Audio Waveform...</span>
            </div>
        )}

        {/* EXPORT OVERLAY */}
        {isExportingVideo && (
             <div className="absolute inset-0 bg-slate-950/95 flex flex-col items-center justify-center z-30 px-6 backdrop-blur-sm">
                
                {renderStatus === 'idle' && (
                    <div className="w-full max-w-sm bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-2xl animate-in fade-in zoom-in duration-200">
                        <h3 className="text-xl font-bold text-white mb-2 flex items-center gap-2">
                            <Video className="text-cyan-400"/> Export Video
                        </h3>
                        <p className="text-slate-400 text-sm mb-6">
                            Burn subtitles permanently into the video. The video will play during this process.
                        </p>
                        
                        <div 
                            className="flex items-center gap-3 p-3 bg-slate-950 rounded-lg mb-6 border border-slate-800 cursor-pointer hover:border-slate-700 transition"
                            onClick={() => setMutePreview(!mutePreview)}
                        >
                            <div className={`p-2 rounded-full ${mutePreview ? 'bg-cyan-900/30 text-cyan-400' : 'bg-slate-800 text-slate-400'}`}>
                                {mutePreview ? <VolumeX size={18} /> : <Volume2 size={18} />}
                            </div>
                            <div className="flex-1">
                                <div className="text-sm font-medium text-slate-200">Mute Audio while Rendering</div>
                                <div className="text-xs text-slate-500">Audio will still be recorded</div>
                            </div>
                            <div className={`w-5 h-5 rounded-full border flex items-center justify-center ${mutePreview ? 'bg-cyan-500 border-cyan-500' : 'border-slate-600'}`}>
                                {mutePreview && <CheckCircle size={12} className="text-white" />}
                            </div>
                        </div>

                        <div className="flex gap-3">
                            <button onClick={closeExport} className="flex-1 py-3 rounded-xl font-semibold bg-slate-800 text-slate-300 hover:bg-slate-700 transition">
                                Cancel
                            </button>
                            <button onClick={startRendering} className="flex-1 py-3 rounded-xl font-bold bg-cyan-500 text-slate-950 hover:bg-cyan-400 transition shadow-lg shadow-cyan-500/20">
                                Start Render
                            </button>
                        </div>
                    </div>
                )}

                {renderStatus === 'rendering' && (
                    <div className="w-full max-w-sm text-center">
                        <div className="text-cyan-400 font-bold text-2xl mb-2 animate-pulse">Rendering...</div>
                        <div className="text-slate-400 text-sm mb-6">Do not close this tab</div>
                        
                        <div className="w-full h-4 bg-slate-800 rounded-full overflow-hidden mb-2 border border-slate-700">
                            <div 
                                className="h-full bg-gradient-to-r from-cyan-500 to-blue-500 transition-all duration-100 ease-linear"
                                style={{ width: `${exportProgress}%` }}
                            />
                        </div>
                        <div className="flex justify-between text-xs font-mono text-slate-500 mb-8">
                            <span>0%</span>
                            <span>{Math.round(exportProgress)}%</span>
                            <span>100%</span>
                        </div>
                        
                        <button onClick={closeExport} className="px-6 py-2 rounded-full border border-red-900/50 text-red-400 hover:bg-red-950/50 transition text-sm">
                            Stop & Cancel
                        </button>
                    </div>
                )}

                {renderStatus === 'completed' && (
                    <div className="w-full max-w-sm bg-slate-900 p-6 rounded-2xl border border-slate-800 shadow-2xl text-center">
                         <div className="w-16 h-16 bg-green-500/10 text-green-500 rounded-full flex items-center justify-center mx-auto mb-4">
                             <CheckCircle size={32} />
                         </div>
                         <h3 className="text-xl font-bold text-white mb-2">Export Complete!</h3>
                         <p className="text-slate-400 text-sm mb-6">Your video has been downloaded.</p>
                         <button onClick={closeExport} className="w-full py-3 rounded-xl font-bold bg-slate-800 text-white hover:bg-slate-700 transition">
                            Close
                         </button>
                    </div>
                )}
            </div>
        )}
      </div>

      {/* 3. Waveform Editor Area */}
      <div className="flex-none relative z-0">
          <WaveformEditor 
            videoRef={videoRef}
            audioBuffer={audioBuffer}
            subtitles={subtitles}
            onSubtitleChange={setSubtitles}
            selectedSubId={selectedSubId}
            onSelectSub={setSelectedSubId}
            zoomLevel={zoomLevel}
          />
          
          {/* Zoom Controls Overlay */}
          <div className="absolute top-2 right-2 flex flex-col gap-2 z-10">
             <button onClick={() => setZoomLevel(z => Math.min(z * 1.5, 500))} className="p-2 bg-slate-800/80 rounded-full backdrop-blur text-white shadow-lg border border-slate-700"><ZoomIn size={16}/></button>
             <button onClick={() => setZoomLevel(z => Math.max(z / 1.5, 10))} className="p-2 bg-slate-800/80 rounded-full backdrop-blur text-white shadow-lg border border-slate-700"><ZoomOut size={16}/></button>
          </div>
      </div>

      {/* 4. Transport Controls */}
      <div className="flex-none p-4 bg-slate-900 border-b border-gray-800 flex items-center justify-between shadow-sm z-10 overflow-x-auto gap-4">
          <div className="flex items-center gap-4 shrink-0">
            <button 
                onClick={togglePlay}
                disabled={!videoSrc || isExportingVideo}
                className="w-12 h-12 flex items-center justify-center bg-cyan-500 rounded-full text-white hover:bg-cyan-400 active:bg-cyan-600 disabled:opacity-50 transition-colors shadow-lg shadow-cyan-500/20"
            >
                {isPlaying ? <Pause size={24} fill="currentColor" /> : <Play size={24} fill="currentColor" className="ml-1"/>}
            </button>
            <div className="font-mono text-sm text-slate-400">
                {formatTime(currentTime).split(',')[0]} / {formatTime(duration).split(',')[0]}
            </div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button onClick={addSubtitle} disabled={!videoSrc || isExportingVideo} className="flex items-center gap-1 px-4 py-2 bg-slate-800 rounded-lg hover:bg-slate-700 disabled:opacity-50 text-sm font-medium border border-slate-700 whitespace-nowrap transition-colors">
                <Plus size={16} /> <span className="hidden sm:inline">Add Sub</span>
            </button>
            <button onClick={exportSRT} disabled={subtitles.length === 0 || isExportingVideo} className="flex items-center gap-1 px-4 py-2 bg-slate-800 rounded-lg hover:bg-slate-700 disabled:opacity-50 text-sm font-medium border border-slate-700 whitespace-nowrap transition-colors">
                <Download size={16} /> <span className="hidden sm:inline">SRT</span>
            </button>
          </div>
      </div>

      {/* 5. Subtitle Editor / List */}
      <div className="flex-1 overflow-y-auto bg-slate-950 p-4 pb-20">
         {selectedSubId ? (
             <div className="bg-slate-900 p-4 rounded-xl border border-slate-800 animate-in slide-in-from-bottom-5 shadow-lg">
                <div className="flex items-center justify-between mb-2">
                    <h3 className="text-sm font-semibold text-cyan-400 flex items-center gap-2">
                        <Edit2 size={14}/> Editing Selected Subtitle
                    </h3>
                    <button 
                        onClick={() => deleteSubtitle(selectedSubId)}
                        className="p-2 text-red-400 hover:bg-red-900/30 rounded-lg transition-colors"
                    >
                        <Trash2 size={18} />
                    </button>
                </div>
                <textarea 
                    value={textEditText}
                    onChange={(e) => handleTextChange(e.target.value)}
                    className="w-full bg-slate-950 border border-slate-700 rounded-lg p-3 text-lg text-slate-100 focus:border-cyan-500 focus:ring-1 focus:ring-cyan-500 outline-none resize-none h-32"
                    placeholder="Enter subtitle text here..."
                    autoFocus
                />
                <div className="mt-2 flex justify-between text-xs text-slate-500">
                    {(() => {
                        const s = subtitles.find(x => x.id === selectedSubId);
                        return s ? <span>{formatTime(s.start)} - {formatTime(s.end)}</span> : null;
                    })()}
                </div>
                <button onClick={() => setSelectedSubId(null)} className="mt-4 w-full py-2 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm text-slate-300 transition">
                    Done
                </button>
             </div>
         ) : (
            <div className="space-y-2">
                <h3 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2">Subtitle List</h3>
                {subtitles.length === 0 ? (
                    <div className="text-center text-slate-600 py-10 italic">
                        No subtitles yet. <br/>Move playhead and tap "Add Sub".
                    </div>
                ) : (
                    subtitles.sort((a,b) => a.start - b.start).map((sub) => (
                        <div 
                            key={sub.id}
                            onClick={() => {
                                setSelectedSubId(sub.id);
                                if (videoRef.current) videoRef.current.currentTime = sub.start;
                            }}
                            className={`p-3 rounded-lg border cursor-pointer transition flex gap-3 ${
                                sub.id === selectedSubId 
                                ? 'bg-cyan-900/20 border-cyan-500/50' 
                                : currentTime >= sub.start && currentTime <= sub.end 
                                    ? 'bg-slate-800 border-slate-700' 
                                    : 'bg-slate-900 border-slate-800 hover:bg-slate-800'
                            }`}
                        >
                            <div className="text-xs font-mono text-slate-500 flex flex-col justify-center min-w-[60px]">
                                <span>{formatTime(sub.start).substring(3,8)}</span>
                                <span>{formatTime(sub.end).substring(3,8)}</span>
                            </div>
                            <div className="text-sm text-slate-200 line-clamp-2 w-full flex items-center">
                                {sub.text || <span className="text-slate-600 italic">Empty text...</span>}
                            </div>
                        </div>
                    ))
                )}
            </div>
         )}
      </div>
    </div>
  );
};

export default App;