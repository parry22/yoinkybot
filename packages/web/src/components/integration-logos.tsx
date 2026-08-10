/** Official-ish brand marks with proper brand colors. */

type MarkProps = { className?: string; size?: number };

function sizeProps(size?: number) {
  const s = size ?? 20;
  return { width: s, height: s };
}

export function XLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <path
        fill="#000000"
        d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-4.714-6.231-5.374 6.231H2.77l7.743-8.835L1.254 2.25H8.08l4.251 5.699L18.244 2.25Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z"
      />
    </svg>
  );
}

export function LinkedInLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#0A66C2" />
      <path
        fill="#FFFFFF"
        d="M7.05 9.2H4.4V19.5h2.65V9.2ZM5.72 4.5a1.54 1.54 0 1 0 0 3.08 1.54 1.54 0 0 0 0-3.08ZM19.6 19.5h-2.64v-5.1c0-1.22-.02-2.78-1.7-2.78-1.7 0-1.96 1.33-1.96 2.7v5.18h-2.64V9.2h2.53v1.4h.04c.35-.67 1.21-1.38 2.5-1.38 2.67 0 3.17 1.76 3.17 4.04v6.24Z"
      />
    </svg>
  );
}

export function SlackLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <path fill="#E01E5A" d="M8.5 14.8a1.7 1.7 0 1 1-1.7-1.7h1.7v1.7Zm.86 0a1.7 1.7 0 1 1 3.4 0v4.26a1.7 1.7 0 1 1-3.4 0V14.8Z" />
      <path fill="#36C5F0" d="M9.36 8.5A1.7 1.7 0 1 1 11.06 6.8V8.5H9.36Zm0 .86a1.7 1.7 0 1 1 0 3.4H5.1a1.7 1.7 0 1 1 0-3.4h4.26Z" />
      <path fill="#2EB67D" d="M15.5 9.36a1.7 1.7 0 1 1 1.7 1.7h-1.7V9.36Zm-.86 0a1.7 1.7 0 1 1-3.4 0V5.1a1.7 1.7 0 1 1 3.4 0v4.26Z" />
      <path fill="#ECB22E" d="M14.64 15.5a1.7 1.7 0 1 1-1.7 1.7V15.5h1.7Zm0-.86a1.7 1.7 0 1 1 0-3.4h4.26a1.7 1.7 0 1 1 0 3.4H14.64Z" />
    </svg>
  );
}

export function NotionLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#FFFFFF" stroke="#000000" strokeWidth="1.2" />
      <path
        fill="#000000"
        d="M7.2 6.4h2.1l4.9 7.6V6.4h1.9v11.2h-2.1l-4.9-7.6v7.6H7.2V6.4Z"
      />
    </svg>
  );
}

export function ChatGPTLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="11" fill="#10A37F" />
      <path
        fill="#FFFFFF"
        d="M12 5.1c1.36 0 2.42.7 2.95 1.75.74-.18 1.55-.02 2.15.5.96.82 1.18 2.2.58 3.28.6.54.97 1.3.97 2.15 0 1.4-.97 2.58-2.28 2.9-.14 1.3-1.23 2.32-2.57 2.32-.75 0-1.42-.31-1.9-.8-.48.49-1.15.8-1.9.8-1.34 0-2.43-1.02-2.57-2.32a2.96 2.96 0 0 1-2.28-2.9c0-.85.37-1.61.97-2.15-.6-1.08-.38-2.46.58-3.28.6-.52 1.41-.68 2.15-.5A3.29 3.29 0 0 1 12 5.1Zm0 2.05c-.68 0-1.23.55-1.23 1.23v1.14L9.8 8.96a1.22 1.22 0 1 0-1.2 2.12l.98.56-1 .58a1.22 1.22 0 1 0 1.22 2.11l.97-.56v1.12a1.23 1.23 0 1 0 2.46 0v-1.12l.97.56a1.22 1.22 0 1 0 1.22-2.11l-1-.58.98-.56A1.22 1.22 0 1 0 14.2 8.96l-.97.56V8.38c0-.68-.55-1.23-1.23-1.23Z"
      />
    </svg>
  );
}

export function ClaudeLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#D97757" />
      <path fill="#FFF8F3" d="M12 5.1c3.3 0 5.9 2.7 5.9 6 0 3.35-2.6 6-5.9 6s-5.9-2.65-5.9-6c0-3.3 2.6-6 5.9-6Zm0 2.15a3.8 3.8 0 1 0 0 7.6 3.8 3.8 0 0 0 0-7.6Z" />
      <circle cx="12" cy="11.05" r="1.55" fill="#D97757" />
    </svg>
  );
}

export function GitHubLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <circle cx="12" cy="12" r="12" fill="#181717" />
      <path
        fill="#FFFFFF"
        d="M12 5.2c-3.76 0-6.8 3.05-6.8 6.82 0 3.01 1.95 5.57 4.66 6.47.34.06.46-.15.46-.33v-1.15c-1.9.41-2.3-.92-2.3-.92-.31-.79-.76-1-.76-1-.62-.43.05-.42.05-.42.68.05 1.04.7 1.04.7.61 1.04 1.6.74 1.99.57.06-.44.24-.74.43-.91-1.51-.17-3.1-.76-3.1-3.37 0-.74.26-1.35.7-1.83-.07-.17-.3-.86.07-1.8 0 0 .57-.18 1.87.7a6.5 6.5 0 0 1 3.41 0c1.3-.88 1.87-.7 1.87-.7.37.94.14 1.63.07 1.8.44.48.7 1.09.7 1.83 0 2.62-1.6 3.2-3.12 3.37.25.21.46.63.46 1.27v1.88c0 .18.12.4.47.33A6.81 6.81 0 0 0 18.8 12c0-3.77-3.04-6.8-6.8-6.8Z"
      />
    </svg>
  );
}

export function BeehiivLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#FFE600" />
      <path
        fill="#111111"
        d="M12 4.2 5.2 8.1v7.8L12 19.8l6.8-3.9V8.1L12 4.2Zm0 1.9 4.9 2.8v1.3L12 12.9 7.1 10.2V8.9L12 6.1Zm-4.9 5.6 4.1 2.35v3.15L7.1 14.8v-3.1Zm5.7 5.5v-3.15l4.1-2.35v3.1l-4.1 2.4Z"
      />
    </svg>
  );
}

export function SubstackLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="4" fill="#FF6719" />
      <path fill="#FFFFFF" d="M5.2 6.2h13.6v2.1H5.2V6.2Zm0 3.4h13.6V18l-6.8-3.7L5.2 18V9.6Z" />
    </svg>
  );
}

export function GranolaLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#1A1A1A" />
      <path
        fill="#A8E66A"
        d="M12 5c2.2 0 3.9 1.2 4.7 3 .9.2 1.7.9 2 1.9-.5 3.6-3.1 6.5-6.7 8.3C8.4 16.4 5.8 13.5 5.3 9.9c.3-1 .1-1.7 2-1.9C8.1 6.2 9.8 5 12 5Zm0 1.6c-1.5 0-2.6.8-3.2 2.1l-.2.5-.5.15c-.7.15-1.15.65-1.35 1.3-.05.3-.05.55 0 .8.6 2.7 2.55 4.85 5.25 6.4 2.7-1.55 4.65-3.7 5.25-6.4.05-.25.05-.5 0-.8-.2-.65-.65-1.15-1.35-1.3l-.5-.15-.2-.5C15.6 7.4 14.5 6.6 12 6.6Z"
      />
    </svg>
  );
}

export function FirefliesLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#6E56CF" />
      <path
        fill="#F7C948"
        d="M12 4.2c1.35 1.85 2 3.4 2 4.85 0 1-.3 1.85-.85 2.55.7-.15 1.3-.55 1.85-1.1.3 1.35.15 2.55-.55 3.65 1.05-.3 1.9-.9 2.5-1.8-.05 2.65-1.75 4.75-5 6.15-3.25-1.4-4.95-3.5-5-6.15.6.9 1.45 1.5 2.5 1.8-.7-1.1-.85-2.3-.55-3.65.55.55 1.15.95 1.85 1.1C10.3 10.9 10 10.05 10 9.05c0-1.45.65-3 2-4.85Z"
      />
    </svg>
  );
}

export function GongLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#111111" />
      <circle cx="12" cy="11" r="5.2" fill="none" stroke="#7C5CFF" strokeWidth="2.2" />
      <circle cx="12" cy="11" r="2" fill="#7C5CFF" />
      <path stroke="#7C5CFF" strokeWidth="2.2" strokeLinecap="round" d="M12 16.2v3.2" />
    </svg>
  );
}

export function LoomLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#625DF5" />
      <circle cx="12" cy="12" r="6.2" fill="none" stroke="#FFFFFF" strokeWidth="2" />
      <circle cx="12" cy="12" r="2.4" fill="#FFFFFF" />
    </svg>
  );
}

export function EmailLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#D9487D" />
      <path
        fill="#FFFFFF"
        d="M5.2 7.4h13.6c.55 0 1 .45 1 1v7.2c0 .55-.45 1-1 1H5.2c-.55 0-1-.45-1-1V8.4c0-.55.45-1 1-1Zm.7 1.5v.2l6.1 3.9 6.1-3.9v-.2H5.9Zm12.2 1.5-5.5 3.5c-.4.25-.9.25-1.3 0l-5.5-3.5V15.6h12.3V10.4Z"
      />
    </svg>
  );
}

export function MailchimpLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#FFE01B" />
      <path
        fill="#000000"
        d="M7.2 15.4c.5 1.2 1.6 2 3 2.1 2.2.2 3.7-1.3 3.7-3.2V8.6h-2.1v5.5c0 .8-.5 1.4-1.3 1.3-.5 0-.9-.4-1-.9l-2.3.9Zm9.1-7.1c-1.1 0-2 .7-2.3 1.7l1.9.6c.1-.3.4-.5.7-.5.4 0 .7.3.7.7v.2h-1.1c-1.4 0-2.4.8-2.4 2.1 0 1.2.9 2.1 2.2 2.1.8 0 1.5-.4 1.8-1v.8h2V10.7c0-1.5-1.1-2.4-2.5-2.4Zm.3 4.6c-.4 0-.7-.3-.7-.7s.3-.7.7-.7.7.3.7.7-.3.7-.7.7Z"
      />
    </svg>
  );
}

export function BrevoLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#0B996E" />
      <path
        fill="#FFFFFF"
        d="M6.5 6.8h5.2c2.3 0 3.8 1.3 3.8 3.2 0 1.2-.6 2.2-1.6 2.7 1.3.5 2.1 1.6 2.1 3 0 2.1-1.6 3.5-4.1 3.5H6.5V6.8Zm2.4 2v2.8h2.5c.9 0 1.5-.5 1.5-1.4s-.6-1.4-1.5-1.4H8.9Zm0 4.7v3.2h2.8c1.1 0 1.8-.6 1.8-1.6s-.7-1.6-1.8-1.6H8.9Z"
      />
    </svg>
  );
}

export function OmnisendLogo({ className, size }: MarkProps) {
  return (
    <svg className={className} viewBox="0 0 24 24" {...sizeProps(size)} aria-hidden="true">
      <rect width="24" height="24" rx="6" fill="#1F6BFF" />
      <path
        fill="#FFFFFF"
        d="M7.2 12a4.8 4.8 0 1 1 9.6 0 4.8 4.8 0 0 1-9.6 0Zm2.1 0a2.7 2.7 0 1 0 5.4 0 2.7 2.7 0 0 0-5.4 0Z"
      />
      <circle cx="17.4" cy="6.6" r="1.3" fill="#7CF0C3" />
    </svg>
  );
}
