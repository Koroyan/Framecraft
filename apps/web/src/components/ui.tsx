'use client';

import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { Dialog as D, Tabs as T, Switch as S, Tooltip as TT } from 'radix-ui';
import { Loader2, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buttonVariants } from './variants';

// ------------------------------------------------------------------ Button

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof buttonVariants> & { loading?: boolean };

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(({ className, variant, size, loading, children, disabled, ...props }, ref) => (
  <button ref={ref} className={cn(buttonVariants({ variant, size }), className)} disabled={disabled || loading} {...props}>
    {loading && <Loader2 className="animate-spin" />}
    {children}
  </button>
));
Button.displayName = 'Button';
export { buttonVariants };

// ------------------------------------------------------------------ Inputs

const field = 'w-full rounded-xl border hairline bg-white/[0.03] px-3.5 text-[15px] text-fog-100 placeholder:text-fog-400 transition focus:border-iris-500/60 focus:bg-white/[0.05] focus:outline-none';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(({ className, ...p }, ref) => (
  <input ref={ref} className={cn(field, 'h-11', className)} {...p} />
));
Input.displayName = 'Input';

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(({ className, ...p }, ref) => (
  <textarea ref={ref} className={cn(field, 'min-h-24 resize-y py-3 leading-relaxed', className)} {...p} />
));
Textarea.displayName = 'Textarea';

export function Label({ className, ...p }: React.LabelHTMLAttributes<HTMLLabelElement>) {
  return <label className={cn('mb-1.5 block text-[13px] font-medium text-fog-300', className)} {...p} />;
}

export function NativeSelect({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(field, 'h-11 appearance-none bg-[url("data:image/svg+xml;utf8,<svg xmlns=%27http://www.w3.org/2000/svg%27 width=%2712%27 height=%2712%27 viewBox=%270 0 24 24%27 fill=%27none%27 stroke=%27%239898a9%27 stroke-width=%272%27><path d=%27m6 9 6 6 6-6%27/></svg>")] bg-[position:right_12px_center] bg-no-repeat pr-9', className)} {...p}>
      {children}
    </select>
  );
}

// ------------------------------------------------------------------ Segmented control

export function Segmented<T extends string | number>({ value, onChange, options, className, size = 'md' }: { value: T; onChange: (v: T) => void; options: { value: T; label: React.ReactNode; hint?: string; disabled?: boolean }[]; className?: string; size?: 'sm' | 'md' }) {
  return (
    <div role="radiogroup" className={cn('inline-flex flex-wrap gap-1 rounded-xl border hairline bg-white/[0.02] p-1', className)}>
      {options.map((o) => (
        <button
          key={String(o.value)}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          title={o.hint}
          disabled={o.disabled}
          onClick={() => onChange(o.value)}
          className={cn(
            'rounded-lg font-medium transition disabled:opacity-35',
            size === 'sm' ? 'px-2.5 py-1 text-xs' : 'px-3 py-1.5 text-[13px]',
            value === o.value ? 'bg-white/[0.1] text-white shadow-[inset_0_0_0_1px_rgb(255_255_255/0.08)]' : 'text-fog-300 hover:text-white',
          )}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ------------------------------------------------------------------ Card, Badge, misc

export function Card({ className, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('surface rounded-2xl', className)} {...p} />;
}

const badgeVariants = cva('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium [&_svg]:size-3', {
  variants: {
    tone: {
      neutral: 'bg-white/[0.06] text-fog-200',
      iris: 'bg-iris-500/15 text-iris-300',
      green: 'bg-signal-green/12 text-signal-green',
      amber: 'bg-signal-amber/12 text-signal-amber',
      red: 'bg-signal-red/12 text-signal-red',
      blue: 'bg-signal-blue/12 text-signal-blue',
    },
  },
  defaultVariants: { tone: 'neutral' },
});

export function Badge({ className, tone, ...p }: React.HTMLAttributes<HTMLSpanElement> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ tone }), className)} {...p} />;
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('skeleton rounded-xl', className)} />;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn('size-4 animate-spin text-fog-300', className)} />;
}

export function EmptyState({ icon, title, description, action }: { icon: React.ReactNode; title: string; description?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-2xl border border-dashed hairline px-6 py-14 text-center">
      <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-iris-500/10 text-iris-300 [&_svg]:size-5">{icon}</div>
      <h3 className="text-base font-semibold text-white">{title}</h3>
      {description && <p className="mt-1 max-w-sm text-sm text-fog-300">{description}</p>}
      {action && <div className="mt-5">{action}</div>}
    </div>
  );
}

export function PageHeader({ title, description, actions, eyebrow }: { title: React.ReactNode; description?: React.ReactNode; actions?: React.ReactNode; eyebrow?: React.ReactNode }) {
  return (
    <div className="mb-6 flex flex-col gap-4 md:mb-8 md:flex-row md:items-end md:justify-between">
      <div>
        {eyebrow && <div className="mb-2 text-xs font-medium uppercase tracking-[0.18em] text-iris-300">{eyebrow}</div>}
        <h1 className="text-[26px] font-semibold tracking-tight text-white md:text-[32px]">{title}</h1>
        {description && <p className="mt-1.5 max-w-2xl text-[15px] text-fog-300">{description}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </div>
  );
}

// ------------------------------------------------------------------ Switch

export function Switch({ checked, onCheckedChange, id, label }: { checked: boolean; onCheckedChange: (v: boolean) => void; id?: string; label?: string }) {
  return (
    <S.Root id={id} aria-label={label} checked={checked} onCheckedChange={onCheckedChange} className="relative h-6 w-10 shrink-0 rounded-full bg-white/10 transition data-[state=checked]:bg-iris-500">
      <S.Thumb className="block size-5 translate-x-0.5 rounded-full bg-white shadow transition-transform data-[state=checked]:translate-x-[18px]" />
    </S.Root>
  );
}

// ------------------------------------------------------------------ Tabs

export const Tabs = T.Root;
export function TabsList({ className, ...p }: React.ComponentProps<typeof T.List>) {
  return <T.List className={cn('mb-5 flex gap-1 overflow-x-auto rounded-xl border hairline bg-white/[0.02] p-1', className)} {...p} />;
}
export function TabsTrigger({ className, ...p }: React.ComponentProps<typeof T.Trigger>) {
  return <T.Trigger className={cn('whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium text-fog-300 transition hover:text-white data-[state=active]:bg-white/[0.08] data-[state=active]:text-white', className)} {...p} />;
}
export const TabsContent = T.Content;

// ------------------------------------------------------------------ Dialog (sheet on mobile)

export function Dialog({ open, onOpenChange, title, description, children, footer, wide }: { open: boolean; onOpenChange: (o: boolean) => void; title: string; description?: string; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="fixed inset-0 z-50 bg-black/70 backdrop-blur-sm data-[state=open]:animate-fade-up" />
        <D.Content
          className={cn(
            'fixed inset-x-0 bottom-0 z-50 max-h-[92dvh] overflow-y-auto rounded-t-3xl border hairline bg-ink-850 p-5 shadow-2xl data-[state=open]:animate-fade-up md:inset-auto md:left-1/2 md:top-1/2 md:w-full md:-translate-x-1/2 md:-translate-y-1/2 md:rounded-3xl md:p-6',
            wide ? 'md:max-w-3xl' : 'md:max-w-lg',
          )}
        >
          <div className="mx-auto mb-4 h-1 w-10 rounded-full bg-white/15 md:hidden" />
          <div className="mb-4 flex items-start justify-between gap-4">
            <div>
              <D.Title className="text-lg font-semibold text-white">{title}</D.Title>
              {description ? <D.Description className="mt-1 text-sm text-fog-300">{description}</D.Description> : <D.Description className="sr-only">{title}</D.Description>}
            </div>
            <D.Close className="rounded-lg p-1.5 text-fog-300 hover:bg-white/5 hover:text-white" aria-label="Close">
              <X className="size-4" />
            </D.Close>
          </div>
          {children}
          {footer && <div className="safe-bottom mt-6 flex flex-col-reverse gap-2 md:flex-row md:justify-end">{footer}</div>}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

// ------------------------------------------------------------------ Tooltip

export function Tip({ content, children }: { content: React.ReactNode; children: React.ReactNode }) {
  return (
    <TT.Provider delayDuration={200}>
      <TT.Root>
        <TT.Trigger asChild>{children}</TT.Trigger>
        <TT.Portal>
          <TT.Content sideOffset={6} className="z-50 max-w-xs rounded-lg border hairline bg-ink-700 px-2.5 py-1.5 text-xs text-fog-100 shadow-xl">
            {content}
          </TT.Content>
        </TT.Portal>
      </TT.Root>
    </TT.Provider>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Label>{label}</Label>
      {children}
      {hint && <p className="mt-1.5 text-xs text-fog-400">{hint}</p>}
    </div>
  );
}
