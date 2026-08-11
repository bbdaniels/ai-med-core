import { useState, useEffect } from 'react';
import { api, apiFetch } from '../api-base';

interface GradingScreenProps {
  tokens: string[];
  language: string;
  translations: {
    loading: string;
    loadingDetail: string;
    explored: string;
    opportunities: string;
    complete: string;
    error: string;
    continue: string;
  };
  onComplete: () => void;
}

interface FeedbackItem {
  title: string;
  description: string;
}

interface SynthesizedFeedback {
  strengths: FeedbackItem[];
  growthAreas: FeedbackItem[];
  openingStatement?: string;
}

interface TranscriptFeedback {
  token: string;
  feedback: SynthesizedFeedback;
}

export default function GradingScreen({ tokens, language, translations, onComplete }: GradingScreenProps) {
  const [status, setStatus] = useState<'loading' | 'grading' | 'complete' | 'error'>('loading');
  const [transcriptFeedbacks, setTranscriptFeedbacks] = useState<TranscriptFeedback[]>([]);
  const [errorMsg, setErrorMsg] = useState('');
  const [expandedSessions, setExpandedSessions] = useState<Set<number>>(new Set([0])); // First session expanded by default

  const toggleSession = (index: number) => {
    setExpandedSessions(prev => {
      const newSet = new Set(prev);
      if (newSet.has(index)) {
        newSet.delete(index);
      } else {
        newSet.add(index);
      }
      return newSet;
    });
  };

  useEffect(() => {
    gradeSession();
  }, []);

  const gradeSession = async () => {
    try {
      setStatus('grading');

      const response = await apiFetch(api('/api/grade-session'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tokens, language }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'Failed to grade session');
      }

      const data = await response.json();
      console.log('=== GRADING API RESPONSE ===');
      console.log('Synthesized feedback:', data.synthesized);

      // Convert synthesized feedback to array format
      const feedbacks: TranscriptFeedback[] = Object.entries(data.synthesized || {}).map(([token, feedback]) => ({
        token,
        feedback: feedback as SynthesizedFeedback,
      }));

      setTranscriptFeedbacks(feedbacks);
      setStatus('complete');
    } catch (error: any) {
      console.error('Error grading session:', error);
      setErrorMsg(error.message || 'Failed to generate feedback');
      setStatus('error');
    }
  };


  if (status === 'loading' || status === 'grading') {
    return (
      <div className="grading-screen">
        <div className="grading-spinner">
          <div className="spinner"></div>
          <h2>{translations.loading}</h2>
          <p>{translations.loadingDetail}</p>
          <div className="progress-bar">
            <div className="progress-bar-fill"></div>
          </div>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="grading-screen">
        <div className="grading-error">
          <h2>{translations.error}</h2>
          <p>{errorMsg}</p>
          <button onClick={onComplete}>{translations.continue}</button>
        </div>
      </div>
    );
  }

  if (transcriptFeedbacks.length === 0) {
    return null;
  }

  return (
    <div className="grading-screen">
      <div className="feedback-content">
        <div className="feedback-carousel">
          {transcriptFeedbacks.map(({ token, feedback }, transcriptIdx) => (
            <div key={token} className="feedback-card">
              {feedback.openingStatement && (
                <div className="opening-statement">
                  <div className="speech-bubble">
                    {feedback.openingStatement}
                  </div>
                </div>
              )}

              {/* Strengths */}
              {feedback.strengths && feedback.strengths.length > 0 && (
                <section className="feedback-section">
                  <h3>✨ {translations.explored}</h3>
                  <div className="feedback-items">
                    {feedback.strengths.map((strength, idx) => (
                      <div key={idx} className="feedback-item strength-item">
                        <h4>{strength.title}</h4>
                        <p>{strength.description}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}

              {/* Growth Areas */}
              {feedback.growthAreas && feedback.growthAreas.length > 0 && (
                <section className="feedback-section">
                  <h3>🌱 {translations.opportunities}</h3>
                  <div className="feedback-items">
                    {feedback.growthAreas.map((area, idx) => (
                      <div key={idx} className="feedback-item growth-item">
                        <h4>{area.title}</h4>
                        <p>{area.description}</p>
                      </div>
                    ))}
                  </div>
                </section>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
