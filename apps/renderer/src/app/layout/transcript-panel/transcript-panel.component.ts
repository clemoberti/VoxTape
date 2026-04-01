import {
  Component,
  OnInit,
  OnDestroy,
  AfterViewInit,
  ElementRef,
  ViewChild,
  Input,
  OnChanges,
  SimpleChanges,
  ChangeDetectorRef,
  ChangeDetectionStrategy,
  inject,
} from '@angular/core';
import { CommonModule } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { Subscription } from 'rxjs';
import { TranslateModule, TranslateService } from '@ngx-translate/core';
import { SessionService, TranscriptSegment } from '../../services/session.service';
import { ElectronIpcService } from '../../services/electron-ipc.service';
import { GlitchLoaderComponent } from '../../shared/glitch-loader/glitch-loader.component';

@Component({
  selector: 'sdn-transcript-panel',
  standalone: true,
  changeDetection: ChangeDetectionStrategy.OnPush,
  imports: [CommonModule, FormsModule, TranslateModule, GlitchLoaderComponent],
  templateUrl: './transcript-panel.component.html',
  styleUrl: './transcript-panel.component.scss',
})
export class TranscriptPanelComponent implements OnInit, OnDestroy, OnChanges, AfterViewInit {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef<HTMLDivElement>;
  @Input() highlightSegmentIds: string[] = [];

  segments: TranscriptSegment[] = [];
  isSpeechActive = false;
  sttStatus: 'loading' | 'ready' | 'error' = 'loading';
  isRecordingElsewhere = false;
  editingSegmentId: string | null = null;
  editingText = '';
  audioPath: string | null = null;
  audioPlaying = false;
  audioCurrentTime = 0;
  audioDuration = 0;
  isRetranscribing = false;
  seekTooltip: { x: number; time: string } | null = null;
  private audioRafId: number | null = null;
  private readonly session = inject(SessionService);
  private readonly ipc = inject(ElectronIpcService);
  readonly cdr = inject(ChangeDetectorRef);
  private readonly translate = inject(TranslateService);
  private subs: Subscription[] = [];

  ngOnInit(): void {
    this.subs.push(
      this.session.segments$.subscribe((segs) => {
        this.segments = segs;
        this.cdr.markForCheck();
        // Auto-scroll after DOM update
        setTimeout(() => this.scrollToBottom(), 50);
      }),
      this.ipc.speechDetected$.subscribe((active) => {
        this.isSpeechActive = active;
        this.cdr.markForCheck();
      }),
      this.ipc.sttStatus$.subscribe((status) => {
        this.sttStatus = status;
        this.cdr.markForCheck();
      }),
      this.session.audioPath$.subscribe((path) => {
        this.audioPath = path;
        this.audioPlaying = false;
        this.audioCurrentTime = 0;
        this.audioDuration = 0;
        this.stopAudioRaf();
        this.cdr.markForCheck();
      }),
      this.session.isRecordingElsewhere$.subscribe((elsewhere) => {
        this.isRecordingElsewhere = elsewhere;
        this.cdr.markForCheck();
      })
    );
  }

  ngAfterViewInit(): void {
    // Scroll to bottom when panel opens (after view is ready)
    setTimeout(() => this.scrollToBottom(), 100);
  }

  ngOnChanges(changes: SimpleChanges): void {
    if (changes['highlightSegmentIds'] && this.highlightSegmentIds.length > 0) {
      // Scroll to first highlighted segment
      setTimeout(() => this.scrollToSegment(this.highlightSegmentIds[0]), 50);
    }
  }

  private scrollToBottom(): void {
    const el = this.scrollContainer?.nativeElement;
    if (el) {
      el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
    }
  }

  ngOnDestroy(): void {
    this.subs.forEach((s) => s.unsubscribe());
    this.stopAudioRaf();
  }

  isHighlighted(segmentId: string): boolean {
    return this.highlightSegmentIds.includes(segmentId);
  }

  restartStt(): void {
    this.ipc.restartStt();
  }

  onSegmentDoubleClick(segment: TranscriptSegment): void {
    this.editingSegmentId = segment.id;
    this.editingText = segment.text;
    this.cdr.markForCheck();
  }

  saveSegmentEdit(): void {
    if (this.editingSegmentId && this.editingText.trim()) {
      this.session.updateSegmentText(this.editingSegmentId, this.editingText.trim());
    }
    this.editingSegmentId = null;
    this.editingText = '';
    this.cdr.markForCheck();
  }

  cancelEdit(): void {
    this.editingSegmentId = null;
    this.editingText = '';
    this.cdr.markForCheck();
  }

  trackSegment(_index: number, segment: TranscriptSegment): string {
    return segment.id;
  }

  formatTime(ms: number): string {
    const totalSec = Math.floor(ms / 1000);
    const min = Math.floor(totalSec / 60);
    const sec = totalSec % 60;
    return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
  }

  getSpeakerLabel(speaker: number): string {
    return this.translate.instant('transcript.speaker', { num: speaker + 1 });
  }

  private scrollToSegment(segmentId: string): void {
    if (!this.scrollContainer) return;
    const container = this.scrollContainer.nativeElement;
    const el = container.querySelector(`[data-segment-id="${segmentId}"]`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }

  togglePlay(audioEl: HTMLAudioElement): void {
    if (audioEl.paused) {
      audioEl.play();
      this.startAudioRaf(audioEl);
    } else {
      audioEl.pause();
      this.stopAudioRaf();
    }
  }

  onAudioTimeUpdate(_audioEl: HTMLAudioElement): void {
    // Handled by RAF for smoother updates
  }

  onAudioLoaded(audioEl: HTMLAudioElement): void {
    this.audioDuration = audioEl.duration || 0;
    this.cdr.markForCheck();
  }

  onAudioEnded(): void {
    this.audioPlaying = false;
    this.audioCurrentTime = 0;
    this.stopAudioRaf();
    this.cdr.markForCheck();
  }

  private startAudioRaf(audioEl: HTMLAudioElement): void {
    const update = () => {
      this.audioCurrentTime = audioEl.currentTime;
      this.cdr.markForCheck();
      this.audioRafId = requestAnimationFrame(update);
    };
    this.audioRafId = requestAnimationFrame(update);
  }

  private stopAudioRaf(): void {
    if (this.audioRafId !== null) {
      cancelAnimationFrame(this.audioRafId);
      this.audioRafId = null;
    }
  }

  onSeekHover(event: MouseEvent): void {
    const container = event.currentTarget as HTMLElement;
    const rect = container.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
    const time = ratio * this.audioDuration;
    this.seekTooltip = { x: event.clientX - rect.left, time: this.formatTime(time * 1000) };
    this.cdr.markForCheck();
  }

  seekAudio(audioEl: HTMLAudioElement, value: number): void {
    audioEl.currentTime = value;
    this.audioCurrentTime = value;
  }

  async retranscribe(): Promise<void> {
    const api = (window as any).voxtape?.session;
    const sessionId = this.session.currentSessionId;
    if (!api?.retranscribe || !sessionId) return;

    this.isRetranscribing = true;
    this.cdr.markForCheck();

    try {
      await api.retranscribe(sessionId);
    } catch (err) {
      console.error('[TranscriptPanel] Retranscribe failed:', err);
    } finally {
      this.isRetranscribing = false;
      this.cdr.markForCheck();
    }
  }

  goToRecordingSession(): void {
    this.session.goToRecordingSession();
  }

  get loaderMessages(): string[] {
    return [
      this.translate.instant('transcript.loader1'),
      this.translate.instant('transcript.loader2'),
      this.translate.instant('transcript.loader3'),
      this.translate.instant('transcript.loader4'),
    ];
  }
}
