async function migrateAudit(db){
 await db.query(`CREATE TABLE IF NOT EXISTS audit_events (
  id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
  occurred_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  actor_type VARCHAR(20) NOT NULL,actor_id INT UNSIGNED NULL,
  actor_name VARCHAR(100) NOT NULL,actor_role VARCHAR(30) NOT NULL,
  category VARCHAR(30) NOT NULL,action VARCHAR(80) NOT NULL,description VARCHAR(255) NOT NULL,
  entity_type VARCHAR(40) NOT NULL,entity_id VARCHAR(40) NOT NULL,
  room_id INT UNSIGNED NULL,room_name VARCHAR(100) NULL,previous_values JSON NULL,new_values JSON NULL,
  INDEX audit_time (occurred_at,id),INDEX audit_actor (actor_id,occurred_at),
  INDEX audit_action (action,occurred_at),INDEX audit_category (category,occurred_at),
  INDEX audit_room (room_id,occurred_at),INDEX audit_entity (entity_type,entity_id),INDEX audit_role (actor_role,occurred_at)
 )`);
 // No backfill: historic actor snapshots cannot be reconstructed honestly.
}
module.exports={migrateAudit};
