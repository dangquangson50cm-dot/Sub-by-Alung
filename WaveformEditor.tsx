import React, { useRef, useEffect, useCallback } from 'react';
import { Subtitle } from '../types';

interface WaveformEditorProps {
  videoRef: React.RefObject<HTMLVideoElement>;
  audioBuffer: AudioBuffer | null;
  subtitles: Subtitle[];
  onSubtitleChange: (subtitles: Subtitle[]) => void;
  selectedSubId: string | null;
  onSelectSub: (id: string | null) => void;
  zoomLevel: number;
}

export const WaveformEditor: React.FC<WaveformEditorProps> = ({
  videoRef,
  audioBuffer,
  subtitles,
  onSubtitleChange,
  selectedSubId,
  onSelectSub,
  zoomLevel
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  
  // Refs for loop state to avoid React re-renders during 60fps loop
  const stateRef = useRef({
    subtitles,
    zoomLevel,
    isDragging: false,
    dragMode: 'none' as 'none' | 'scrub' | 'move-sub' | 'resize-left' | 'resize-right',
    dragTargetId: null as string | null,
    dragStartX: 0,
    dragStartTime: 0, // Time when drag started
    dragOriginalStart: 0, // Sub start when drag started
    dragOriginalEnd: 0, // Sub end when drag started
    isPlaying: false
  });

  // Sync refs with props
  useEffect(() => {
    stateRef.current.subtitles = subtitles;
    stateRef.current.zoomLevel = zoomLevel;
  }, [subtitles, zoomLevel]);

  // Helper: Convert X pixel to Time
  const xToTime = (x: number, centerTime: number, width: number, zoom: number) => {
    const centerX = width / 2;
    const diffX = x - centerX;
    return centerTime + diffX / zoom;
  };

  // Helper: Convert Time to X pixel
  const timeToX = (time: number, centerTime: number, width: number, zoom: number) => {
    const centerX = width / 2;
    const diffTime = time - centerTime;
    return centerX + diffTime * zoom;
  };

  // Main Draw Loop
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    // Optimize canvas for frequent redraws, alpha: false since we draw full background
    const ctx = canvas?.getContext('2d', { alpha: false }); 
    const video = videoRef.current;
    
    if (!canvas || !ctx || !video) return;

    const width = canvas.width;
    const height = canvas.height;
    const zoom = stateRef.current.zoomLevel;
    const currentTime = video.currentTime;
    
    // --- 1. Clear with Deep Slate Blue ---
    ctx.fillStyle = '#0f172a'; // Slate-900
    ctx.fillRect(0, 0, width, height);

    // --- 2. Draw Waveform (Fixed Time Grid / Anti-Jitter) ---
    if (audioBuffer) {
      const channelData = audioBuffer.getChannelData(0);
      const ampHeight = height / 2;
      
      // Use Bright Cyan for high visibility
      ctx.fillStyle = '#22d3ee'; // Cyan-400

      // Calculate Grid Parameters
      // The step size in samples. We lock this to an integer to ensure consistent buckets.
      // We aim for approx 1 pixel width per bucket, but locked to audio data.
      const samplesPerPixel = audioBuffer.sampleRate / zoom;
      const step = Math.ceil(samplesPerPixel); 
      
      // Calculate Visible Range in Time
      const startTimeAtLeft = xToTime(0, currentTime, width, zoom);
      const endTimeAtRight = xToTime(width, currentTime, width, zoom);
      
      // Calculate Sample Indices aligned to the grid (absolute 0)
      const startBucketIndex = Math.floor((startTimeAtLeft * audioBuffer.sampleRate) / step);
      const endBucketIndex = Math.ceil((endTimeAtRight * audioBuffer.sampleRate) / step);

      // Draw Loop: Iterate through Fixed Buckets, map to Screen X
      // Expanding range slightly to ensure edges are covered
      for (let i = startBucketIndex - 1; i <= endBucketIndex + 1; i++) {
        const startSample = i * step;
        const endSample = startSample + step;

        // Skip if completely out of bounds of audio data
        if (endSample < 0 || startSample >= channelData.length) continue;

        // Clamp for data access
        const safeStart = Math.max(0, startSample);
        const safeEnd = Math.min(channelData.length, endSample);
        
        // Calculate X position on screen for this bucket
        // We calculate xStart and xEnd to ensure we fill the space (no gaps)
        const timeStart = startSample / audioBuffer.sampleRate;
        const timeEnd = endSample / audioBuffer.sampleRate;
        
        const xStart = timeToX(timeStart, currentTime, width, zoom);
        const xEnd = timeToX(timeEnd, currentTime, width, zoom);
        
        // Pixel Snap: Round to nearest pixel to avoid sub-pixel blurring
        const drawX = Math.floor(xStart);
        const drawW = Math.max(1, Math.ceil(xEnd) - drawX);

        if (drawX > width) break; // Optimization
        if (drawX + drawW < 0) continue;

        // Peak Sampling
        let min = 1.0;
        let max = -1.0;
        let hasData = false;
        
        // Adaptive stride for performance when zoomed out
        // If step is huge (zoomed out), we skip samples. 
        // We limit max iterations to ~50 per bar to keep 60fps.
        const stride = Math.max(1, Math.floor((safeEnd - safeStart) / 40)); 

        for (let j = safeStart; j < safeEnd; j += stride) {
          const val = channelData[j];
          if (val < min) min = val;
          if (val > max) max = val;
          hasData = true;
        }

        if (hasData && max >= min) {
            // Apply slight smoothing/noise gate
            if (max - min < 0.005) {
                // Silence - draw flat line
                const y = Math.floor(ampHeight);
                ctx.fillRect(drawX, y, drawW, 1);
            } else {
                // Pixel Snap Y
                const yMin = Math.floor(ampHeight + min * ampHeight * 0.9);
                const yMax = Math.ceil(ampHeight + max * ampHeight * 0.9);
                const h = Math.max(1, yMax - yMin);
                
                ctx.fillRect(drawX, yMin, drawW, h);
            }
        }
      }
    }

    // --- 3. Draw Grid/Time ---
    ctx.fillStyle = '#334155'; // Slate-700
    ctx.font = '10px monospace';
    
    // Draw grid lines based on integer seconds
    const startGridTime = Math.floor(xToTime(0, currentTime, width, zoom));
    const endGridTime = Math.ceil(xToTime(width, currentTime, width, zoom));

    for (let t = startGridTime; t <= endGridTime; t++) {
        const rawX = timeToX(t, currentTime, width, zoom);
        const x = Math.floor(rawX);
        
        if (x >= -2 && x <= width) {
            ctx.fillRect(x, 0, 1, height); // Grid line
            
            // Time label every 5 seconds (or less if zoomed in)
            const labelStep = zoom > 100 ? 1 : 5;
            if (t % labelStep === 0) {
               ctx.fillStyle = '#94a3b8'; // Slate-400
               ctx.fillText(new Date(t * 1000).toISOString().substr(14, 5), x + 4, 12);
               ctx.fillStyle = '#334155'; // Reset
            }
        }
    }

    // --- 4. Draw Subtitles ---
    const subs = stateRef.current.subtitles;
    const handleWidth = 4; // Reduced from 10 to 4 for thinner handles

    subs.forEach(sub => {
      // Logic same as before but ensure pixel snapping
      const xStart = Math.floor(timeToX(sub.start, currentTime, width, zoom));
      const xEnd = Math.floor(timeToX(sub.end, currentTime, width, zoom));
      const subWidth = Math.max(2, xEnd - xStart);
      const isSelected = sub.id === selectedSubId;

      if (xEnd < 0 || xStart > width) return;

      // Draw Block
      ctx.fillStyle = isSelected ? 'rgba(34, 211, 238, 0.2)' : 'rgba(51, 65, 85, 0.6)'; 
      ctx.fillRect(xStart, 20, subWidth, height - 40);
      
      // Border
      ctx.strokeStyle = isSelected ? '#22d3ee' : '#475569';
      ctx.lineWidth = 2;
      ctx.strokeRect(xStart, 20, subWidth, height - 40);

      // Text Snippet
      ctx.fillStyle = '#e2e8f0'; 
      ctx.font = '12px sans-serif';
      const textMetrics = ctx.measureText(sub.text);
      // Clip text
      ctx.save();
      ctx.beginPath();
      ctx.rect(xStart, 20, subWidth, height - 40);
      ctx.clip();
      ctx.fillText(sub.text, xStart + 4, height / 2 + 4);
      ctx.restore();

      // Draw Handles if selected
      if (isSelected) {
        ctx.fillStyle = '#fbbf24'; // Yellow
        ctx.fillRect(xStart, 20, handleWidth, height - 40);
        ctx.fillRect(xEnd - handleWidth, 20, handleWidth, height - 40);
      }
    });

    // --- 5. Draw Center Playhead ---
    const centerX = Math.floor(width / 2);
    ctx.beginPath();
    ctx.strokeStyle = '#ef4444'; // Red-500
    ctx.lineWidth = 1; 
    ctx.moveTo(centerX + 0.5, 0);
    ctx.lineTo(centerX + 0.5, height);
    ctx.stroke();

  }, [audioBuffer, selectedSubId, videoRef]);

  // Animation Loop
  useEffect(() => {
    let animationFrameId: number;
    const loop = () => {
      draw();
      animationFrameId = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(animationFrameId);
  }, [draw]);

  // --- Interaction Logic (Same as before) ---

  const handlePointerDown = (e: React.PointerEvent) => {
    const canvas = canvasRef.current;
    if (!canvas || !videoRef.current) return;
    
    canvas.setPointerCapture(e.pointerId);
    
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const width = canvas.width;
    const zoom = stateRef.current.zoomLevel;
    const currentTime = videoRef.current.currentTime;
    
    const timeAtCursor = xToTime(x, currentTime, width, zoom);

    const subs = stateRef.current.subtitles;
    let hitSubId: string | null = null;
    let hitType: 'none' | 'body' | 'left' | 'right' = 'none';

    // Reduced hit width for handles to match visual size better, 
    // but kept slightly larger than visual (4px) for touch usability.
    const handleHitWidth = 10; 
    const handleTimeWidth = handleHitWidth / zoom;

    for (let i = subs.length - 1; i >= 0; i--) {
        const sub = subs[i];
        if (timeAtCursor >= sub.start - handleTimeWidth && timeAtCursor <= sub.end + handleTimeWidth) {
           if (sub.id === selectedSubId) {
               if (Math.abs(timeAtCursor - sub.start) < handleTimeWidth) {
                   hitSubId = sub.id;
                   hitType = 'left';
                   break;
               } else if (Math.abs(timeAtCursor - sub.end) < handleTimeWidth) {
                   hitSubId = sub.id;
                   hitType = 'right';
                   break;
               }
           }
           if (timeAtCursor >= sub.start && timeAtCursor <= sub.end) {
               hitSubId = sub.id;
               hitType = 'body';
               break;
           }
        }
    }

    stateRef.current.isDragging = true;
    stateRef.current.dragStartX = x;
    stateRef.current.dragStartTime = currentTime;

    if (hitSubId && hitType !== 'none') {
        const sub = subs.find(s => s.id === hitSubId)!;
        stateRef.current.dragTargetId = hitSubId;
        stateRef.current.dragOriginalStart = sub.start;
        stateRef.current.dragOriginalEnd = sub.end;
        onSelectSub(hitSubId); 

        if (hitType === 'body') stateRef.current.dragMode = 'move-sub';
        if (hitType === 'left') stateRef.current.dragMode = 'resize-left';
        if (hitType === 'right') stateRef.current.dragMode = 'resize-right';

        videoRef.current.pause();
    } else {
        stateRef.current.dragMode = 'scrub';
        if (selectedSubId) onSelectSub(null);
        stateRef.current.isPlaying = !videoRef.current.paused;
        videoRef.current.pause();
    }
  };

  const handlePointerMove = (e: React.PointerEvent) => {
    if (!stateRef.current.isDragging || !videoRef.current || !canvasRef.current) return;

    const canvas = canvasRef.current;
    const rect = canvas.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const zoom = stateRef.current.zoomLevel;
    
    const dx = x - stateRef.current.dragStartX;
    const dt = dx / zoom;

    const { dragMode, dragTargetId, dragOriginalStart, dragOriginalEnd, dragStartTime } = stateRef.current;

    if (dragMode === 'scrub') {
        videoRef.current.currentTime = Math.max(0, dragStartTime - dt);
    } 
    else if (dragTargetId) {
        const updatedSubs = stateRef.current.subtitles.map(sub => {
            if (sub.id !== dragTargetId) return sub;

            let newStart = sub.start;
            let newEnd = sub.end;

            if (dragMode === 'move-sub') {
                newStart = Math.max(0, dragOriginalStart + dt);
                newEnd = Math.max(newStart + 0.1, dragOriginalEnd + dt);
            } else if (dragMode === 'resize-left') {
                newStart = Math.min(Math.max(0, dragOriginalStart + dt), dragOriginalEnd - 0.2);
            } else if (dragMode === 'resize-right') {
                newEnd = Math.max(dragOriginalStart + 0.2, dragOriginalEnd + dt);
            }
            return { ...sub, start: newStart, end: newEnd };
        });

        stateRef.current.subtitles = updatedSubs;
        onSubtitleChange(updatedSubs); 
    }
  };

  const handlePointerUp = (e: React.PointerEvent) => {
      const canvas = canvasRef.current;
      if (canvas) canvas.releasePointerCapture(e.pointerId);

      if (stateRef.current.dragMode === 'scrub' && stateRef.current.isPlaying && videoRef.current) {
          videoRef.current.play();
      }

      stateRef.current.isDragging = false;
      stateRef.current.dragMode = 'none';
      stateRef.current.dragTargetId = null;
  };

  return (
    <div 
      ref={containerRef} 
      className="relative w-full h-40 bg-[#0f172a] touch-none select-none border-b border-gray-800"
    >
      <canvas
        ref={canvasRef}
        width={window.innerWidth} 
        height={160}
        className="w-full h-full cursor-pointer touch-none block"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      />
    </div>
  );
};