import { useState } from 'react';
import { Brain, Check, FileText, Sparkles } from 'lucide-react';

const STEPS = [
  { icon: <Sparkles size={22} />, title: '创建空间', desc: '在左侧新建一个空间（项目 / 领域 / 资料），把相关笔记归拢在一起。' },
  { icon: <FileText size={22} />, title: '写第一篇笔记', desc: '在空间中新建笔记并输入内容；保存后 AI 会自动整理成主题与标签。' },
  { icon: <Brain size={22} />, title: '查看 Wiki 主题', desc: '进入「智能整理」审阅 AI 生成的主题与建议，逐步构建你的知识库。' }
];

/**
 * First-visit onboarding (Phase C4 / U11). Shown once per browser (flagged in
 * localStorage) so returning users are never interrupted. Purely client-side —
 * no backend endpoint.
 */
export function Onboarding({ onClose }: { onClose: () => void }) {
  const [step, setStep] = useState(0);
  const finish = () => {
    try { localStorage.setItem('ml.onboarded', '1'); } catch { /* ignore */ }
    onClose();
  };
  const last = step === STEPS.length - 1;

  return (
    <div className="cmdk-backdrop" onClick={finish}>
      <div className="onboarding" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="新手引导">
        <div className="onboarding-head">
          <span className="onboarding-brand"><Sparkles size={16} /> ZhiPane</span>
          <button className="onboarding-skip" onClick={finish}>跳过</button>
        </div>
        <div className="onboarding-body">
          <div className="onboarding-step-icon">{STEPS[step].icon}</div>
          <h3>{STEPS[step].title}</h3>
          <p className="muted">{STEPS[step].desc}</p>
          <div className="onboarding-dots">
            {STEPS.map((_, i) => <span key={i} className={`dot${i === step ? ' on' : ''}`} />)}
          </div>
        </div>
        <div className="onboarding-actions">
          {step > 0 && <button className="ghost sm" onClick={() => setStep(step - 1)}>上一步</button>}
          <button className="primary sm" onClick={() => (last ? finish() : setStep(step + 1))}>
            {last ? <><Check size={14} /> 开始使用</> : '下一步'}
          </button>
        </div>
      </div>
    </div>
  );
}
