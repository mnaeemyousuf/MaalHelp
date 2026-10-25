import { BRAND } from '@shared/brand';
import { cn } from '@/lib/utils';

/** Logo mark + wordmark. `tone="dark"` for use on brand-coloured backgrounds. */
export function BrandLogo({ tone = 'light', tagline = true, size = 'md', className }: { tone?: 'light' | 'dark'; tagline?: boolean; size?: 'sm' | 'md' | 'lg'; className?: string }) {
  const mark = size === 'lg' ? 'size-11' : size === 'sm' ? 'size-7' : 'size-9';
  const name = size === 'lg' ? 'text-2xl' : size === 'sm' ? 'text-sm' : 'text-[17px]';
  return (
    <span className={cn('inline-flex items-center gap-2.5', className)}>
      <img src="/brand/logo-mark.svg" alt="" className={cn(mark, tone === 'dark' && 'rounded-[28%] ring-1 ring-white/25')} />
      <span className="leading-none">
        <span className={cn('block font-extrabold tracking-tight', name, tone === 'dark' ? 'text-white' : 'text-brand-900')}>
          Maal <span className={tone === 'dark' ? 'text-accent-400' : 'text-brand-600'}>Help</span>
        </span>
        {tagline && <span className={cn('mt-1 block whitespace-nowrap text-[10px] font-semibold', tone === 'dark' ? 'text-brand-200' : 'text-ink-400')}>{BRAND.tagline}</span>}
      </span>
      <span className="sr-only">{BRAND.name}</span>
    </span>
  );
}
