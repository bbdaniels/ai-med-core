// GET /api/config, once. `configLoaded` turns true when it has answered or
// failed; a failure keeps DEFAULT_PROJECT_CONFIG, so a project whose config
// cannot be read degrades to the plain simulator page rather than a blank one.

import { useEffect, useState } from 'react';
import { PROJECT, api, apiFetch } from '../api-base';
import { DEFAULT_PROJECT_CONFIG, type ProjectConfig, parseProjectConfig } from './project-config';

export function useProjectConfig(): { configLoaded: boolean; config: ProjectConfig } {
  const [state, setState] = useState<{ configLoaded: boolean; config: ProjectConfig }>(
    { configLoaded: false, config: DEFAULT_PROJECT_CONFIG });
  useEffect(() => {
    apiFetch(api('/api/config'))
      .then(res => res.json())
      .then(data => setState({ configLoaded: true, config: parseProjectConfig(data, PROJECT) }))
      .catch(() => setState(prev => ({ ...prev, configLoaded: true })));
  }, []);
  return state;
}
