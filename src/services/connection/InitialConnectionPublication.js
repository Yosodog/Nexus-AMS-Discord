import { ConnectionPublicationManager } from './ConnectionPublicationManager.js';

export const publishInitialConnections = ({ publication = [], ...options } = {}) => {
  const source = {
    read: async () => structuredClone(publication),
  };
  const manager = new ConnectionPublicationManager({ source, ...options });

  return manager.refresh();
};
