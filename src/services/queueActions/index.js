import * as allianceDeparture from './allianceDeparture.js';
import * as allianceRoleRemoval from './allianceRoleRemoval.js';
import * as beigeAlert from './beigeAlert.js';
import * as inactivityAlert from './inactivityAlert.js';
import * as warAlert from './warAlert.js';
import * as warRoomArchive from './warRoomArchive.js';
import * as warRoomCreate from './warRoomCreate.js';

export const queueActions = Object.freeze({
  WAR_ALERT: warAlert,
  ALLIANCE_DEPARTURE: allianceDeparture,
  INACTIVITY_ALERT: inactivityAlert,
  ALLIANCE_ROLE_REMOVAL: allianceRoleRemoval,
  BEIGE_ALERT: beigeAlert,
  WAR_ROOM_CREATE: warRoomCreate,
  WAR_ROOM_ARCHIVE: warRoomArchive,
});
