import { redirect } from 'next/navigation';

/** The footage entry point is now part of the unified creation flow. */
export default function FootageAdsPage() {
  redirect('/app/ads/create?from=videos');
}
