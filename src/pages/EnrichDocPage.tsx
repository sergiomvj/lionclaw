// @deprecated - migrado para pipeline-engine/pipeline-store. Mantido como redirect.
import { useEffect } from 'react';
import { useAppStore } from '@/stores/app-store';

export function EnrichDocPage() {
  const { setPage } = useAppStore();

  useEffect(() => {
    setPage('pipeline');
  }, [setPage]);

  return null;
}

export default EnrichDocPage;
