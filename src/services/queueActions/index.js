import * as allianceDeparture from './allianceDeparture.js';
import * as allianceRoleRemoval from './allianceRoleRemoval.js';
import * as alertDelivery from './alertDelivery.js';
import * as applicationDiscordReconcile from './applicationDiscordReconcile.js';
import * as beigeAlert from './beigeAlert.js';
import * as cityTierSync from './cityTierSync.js';
import * as blockadeReliefNotification from './blockadeReliefNotification.js';
import * as inactivityAlert from './inactivityAlert.js';
import * as privateNotification from './privateNotification.js';
import * as warAlert from './warAlert.js';
import * as warRoomArchive from './warRoomArchive.js';
import * as warRoomCreate from './warRoomCreate.js';

export const queueActions = Object.freeze({
  ALERT_DELIVERY_V1: alertDelivery,
  APPLICATION_DISCORD_RECONCILE: applicationDiscordReconcile,
  WAR_ALERT: warAlert,
  ALLIANCE_DEPARTURE: allianceDeparture,
  INACTIVITY_ALERT: inactivityAlert,
  ALLIANCE_ROLE_REMOVAL: allianceRoleRemoval,
  BEIGE_ALERT: beigeAlert,
  CITY_TIER_SYNC: cityTierSync,
  BLOCKADE_RELIEF_NOTIFICATION: blockadeReliefNotification,
  WAR_ROOM_CREATE: warRoomCreate,
  WAR_ROOM_ARCHIVE: warRoomArchive,
  PRIVATE_NOTIFICATION: privateNotification,
});
