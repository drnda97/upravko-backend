-- Upravko: početna šema. Sva vremena su UTC.
-- Princip: ništa se ne briše preko API-ja. Finansijske stavke su nepromenljive.

CREATE TABLE organizations (
  id CHAR(36) PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  logo_variant ENUM('upravko','stanplus','text') NOT NULL DEFAULT 'text',
  logo_url VARCHAR(500) NULL,
  color_primary CHAR(7) NOT NULL DEFAULT '#2B44C9',
  color_primary_dark CHAR(7) NOT NULL DEFAULT '#8EA2FF',
  color_secondary CHAR(7) NOT NULL DEFAULT '#0E1631',
  color_accent CHAR(7) NOT NULL DEFAULT '#C6F36D',
  is_test TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE users (
  id CHAR(36) PRIMARY KEY,
  email VARCHAR(190) NOT NULL UNIQUE,
  password_hash VARCHAR(100) NULL,
  full_name VARCHAR(120) NOT NULL,
  phone VARCHAR(40) NULL,
  theme_pref ENUM('system','light','dark') NOT NULL DEFAULT 'system',
  notify_pref ENUM('all','urgent') NOT NULL DEFAULT 'all',
  is_test TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL
) ENGINE=InnoDB;

CREATE TABLE refresh_tokens (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  expires_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE password_tokens (
  id CHAR(36) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  token_hash CHAR(64) NOT NULL UNIQUE,
  purpose ENUM('reset','invite') NOT NULL,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE push_tokens (
  token VARCHAR(255) PRIMARY KEY,
  user_id CHAR(36) NOT NULL,
  platform VARCHAR(20) NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE uploads (
  path VARCHAR(255) PRIMARY KEY,
  uploaded_by CHAR(36) NULL,
  original_name VARCHAR(255) NOT NULL,
  mime VARCHAR(100) NOT NULL,
  size_bytes INT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE buildings (
  id CHAR(36) PRIMARY KEY,
  organization_id CHAR(36) NOT NULL,
  address VARCHAR(190) NOT NULL,
  city VARCHAR(100) NOT NULL,
  apartments_count INT NOT NULL,
  cover_image_path VARCHAR(255) NULL,
  currency ENUM('RSD','EUR','USD') NOT NULL DEFAULT 'RSD',
  fee_mode ENUM('per_apartment','per_m2') NOT NULL DEFAULT 'per_apartment',
  fee_amount DECIMAL(14,2) NOT NULL DEFAULT 0,
  fee_day_of_month TINYINT NOT NULL DEFAULT 1,
  payment_mode ENUM('direct','infostan') NOT NULL DEFAULT 'direct',
  bank_account CHAR(18) NULL,
  recipient_name VARCHAR(70) NULL,
  building_code VARCHAR(20) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE apartments (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  number INT NOT NULL,
  area_m2 DECIMAL(8,2) NULL,
  UNIQUE KEY uq_apartment (building_id, number),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE building_managers (
  building_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (building_id, user_id),
  KEY idx_manager_user (user_id),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE building_invite_codes (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  token VARCHAR(64) NOT NULL UNIQUE,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL,
  revoked_at DATETIME(3) NULL,
  KEY idx_invite_building (building_id, active),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE memberships (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  apartment_id CHAR(36) NOT NULL,
  user_id CHAR(36) NOT NULL,
  role ENUM('owner','tenant') NOT NULL,
  status ENUM('pending','approved','rejected') NOT NULL DEFAULT 'pending',
  invite_code_id CHAR(36) NULL,
  decided_by CHAR(36) NULL,
  decided_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_membership_user (user_id, status),
  KEY idx_membership_building (building_id, status),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (apartment_id) REFERENCES apartments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (invite_code_id) REFERENCES building_invite_codes(id) ON DELETE SET NULL,
  FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE issues (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  title VARCHAR(190) NOT NULL,
  short_title VARCHAR(80) NULL,
  description TEXT NOT NULL,
  location ENUM('ulaz','lift','stepeniste','krov','podrum','fasada','parking','ostalo') NOT NULL,
  urgency ENUM('low','medium','high') NOT NULL,
  status ENUM('reported','received','offers','voting','planned','in_progress','resolved','rejected') NOT NULL DEFAULT 'reported',
  reporter_user_id CHAR(36) NULL,
  reporter_apartment_id CHAR(36) NULL,
  is_anonymous TINYINT(1) NOT NULL DEFAULT 0,
  rejected_reason TEXT NULL,
  chosen_offer_id CHAR(36) NULL,
  resolved_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_issue_building (building_id, status),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (reporter_user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (reporter_apartment_id) REFERENCES apartments(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE issue_photos (
  id CHAR(36) PRIMARY KEY,
  issue_id CHAR(36) NOT NULL,
  path VARCHAR(255) NOT NULL,
  kind ENUM('report','after_fix') NOT NULL DEFAULT 'report',
  sort INT NOT NULL DEFAULT 0,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE issue_hurries (
  issue_id CHAR(36) NOT NULL,
  apartment_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  PRIMARY KEY (issue_id, apartment_id),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (apartment_id) REFERENCES apartments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE issue_comments (
  id CHAR(36) PRIMARY KEY,
  issue_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  body TEXT NOT NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE issue_events (
  id CHAR(36) PRIMARY KEY,
  issue_id CHAR(36) NOT NULL,
  type ENUM('reported','status_changed','urgency_changed','comment','offer_added','offer_withdrawn','vote_opened','vote_closed','service_contacted','resolved','rejected','photos_added') NOT NULL,
  actor_user_id CHAR(36) NULL,
  payload JSON NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_event_issue (issue_id, created_at),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE offers (
  id CHAR(36) PRIMARY KEY,
  issue_id CHAR(36) NOT NULL,
  contractor VARCHAR(190) NOT NULL,
  price DECIMAL(14,2) NOT NULL,
  duration_days INT NOT NULL,
  pdf_path VARCHAR(255) NULL,
  note TEXT NULL,
  withdrawn_at DATETIME(3) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE offer_photos (
  id CHAR(36) PRIMARY KEY,
  offer_id CHAR(36) NOT NULL,
  path VARCHAR(255) NOT NULL,
  sort INT NOT NULL DEFAULT 0,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE issues ADD CONSTRAINT fk_issue_offer FOREIGN KEY (chosen_offer_id) REFERENCES offers(id) ON DELETE SET NULL;

CREATE TABLE votes_sessions (
  id CHAR(36) PRIMARY KEY,
  issue_id CHAR(36) NOT NULL,
  deadline DATETIME(3) NOT NULL,
  majority_rule ENUM('simple','two_thirds') NOT NULL DEFAULT 'simple',
  opened_by CHAR(36) NULL,
  opened_at DATETIME(3) NOT NULL,
  closed_at DATETIME(3) NULL,
  winner_offer_id CHAR(36) NULL,
  KEY idx_session_open (closed_at, deadline),
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE CASCADE,
  FOREIGN KEY (opened_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (winner_offer_id) REFERENCES offers(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE votes (
  session_id CHAR(36) NOT NULL,
  apartment_id CHAR(36) NOT NULL,
  offer_id CHAR(36) NOT NULL,
  voted_by_user_id CHAR(36) NULL,
  updated_at DATETIME(3) NOT NULL,
  PRIMARY KEY (session_id, apartment_id),
  FOREIGN KEY (session_id) REFERENCES votes_sessions(id) ON DELETE CASCADE,
  FOREIGN KEY (apartment_id) REFERENCES apartments(id) ON DELETE CASCADE,
  FOREIGN KEY (offer_id) REFERENCES offers(id) ON DELETE CASCADE,
  FOREIGN KEY (voted_by_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE ledger_entries (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  type ENUM('income','expense','opening','reversal') NOT NULL,
  sign TINYINT NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  title VARCHAR(190) NOT NULL,
  occurred_on DATE NOT NULL,
  apartment_id CHAR(36) NULL,
  issue_id CHAR(36) NULL,
  invoice_path VARCHAR(255) NULL,
  reverses_entry_id CHAR(36) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_ledger_building (building_id, occurred_on),
  UNIQUE KEY uq_reversal (reverses_entry_id),
  CONSTRAINT chk_ledger_amount CHECK (amount > 0),
  CONSTRAINT chk_ledger_sign CHECK (sign IN (-1, 1)),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (apartment_id) REFERENCES apartments(id) ON DELETE SET NULL,
  FOREIGN KEY (issue_id) REFERENCES issues(id) ON DELETE SET NULL,
  FOREIGN KEY (reverses_entry_id) REFERENCES ledger_entries(id) ON DELETE SET NULL,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TRIGGER ledger_no_update BEFORE UPDATE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries je nepromenljiva: ispravka ide kao storno stavka';
CREATE TRIGGER ledger_no_delete BEFORE DELETE ON ledger_entries FOR EACH ROW
  SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ledger_entries je nepromenljiva: ispravka ide kao storno stavka';

CREATE TABLE charges (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  apartment_id CHAR(36) NOT NULL,
  period CHAR(7) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  due_date DATE NOT NULL,
  paid_at DATETIME(3) NULL,
  payment_entry_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  UNIQUE KEY uq_charge (apartment_id, period),
  KEY idx_charge_due (building_id, paid_at, due_date),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (apartment_id) REFERENCES apartments(id) ON DELETE CASCADE,
  FOREIGN KEY (payment_entry_id) REFERENCES ledger_entries(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE bank_imports (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  file_name VARCHAR(190) NOT NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE bank_import_lines (
  id CHAR(36) PRIMARY KEY,
  import_id CHAR(36) NOT NULL,
  occurred_on DATE NOT NULL,
  payer VARCHAR(190) NOT NULL,
  amount DECIMAL(14,2) NOT NULL,
  reference VARCHAR(40) NULL,
  purpose VARCHAR(255) NULL,
  matched_apartment_id CHAR(36) NULL,
  matched_charge_id CHAR(36) NULL,
  ledger_entry_id CHAR(36) NULL,
  status ENUM('matched','unmatched') NOT NULL DEFAULT 'unmatched',
  FOREIGN KEY (import_id) REFERENCES bank_imports(id) ON DELETE CASCADE,
  FOREIGN KEY (matched_apartment_id) REFERENCES apartments(id) ON DELETE SET NULL,
  FOREIGN KEY (matched_charge_id) REFERENCES charges(id) ON DELETE SET NULL,
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE announcements (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  type ENUM('info','urgent','meeting','payment_reminder') NOT NULL,
  title VARCHAR(190) NOT NULL,
  summary VARCHAR(255) NULL,
  body TEXT NOT NULL,
  attachment_path VARCHAR(255) NULL,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  expires_at DATE NULL,
  event_at DATETIME(3) NULL,
  event_place VARCHAR(190) NULL,
  created_by CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_announcement_building (building_id, created_at),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE announcement_reads (
  announcement_id CHAR(36) NOT NULL,
  apartment_id CHAR(36) NOT NULL,
  read_at DATETIME(3) NOT NULL,
  PRIMARY KEY (announcement_id, apartment_id),
  FOREIGN KEY (announcement_id) REFERENCES announcements(id) ON DELETE CASCADE,
  FOREIGN KEY (apartment_id) REFERENCES apartments(id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE private_threads (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  resident_user_id CHAR(36) NOT NULL,
  subject VARCHAR(190) NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  converted_issue_id CHAR(36) NULL,
  conversion_requested_at DATETIME(3) NULL,
  conversion_consented_at DATETIME(3) NULL,
  conversion_declined_at DATETIME(3) NULL,
  manager_read_at DATETIME(3) NULL,
  resident_read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_thread_building (building_id, status),
  KEY idx_thread_resident (resident_user_id),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (resident_user_id) REFERENCES users(id) ON DELETE CASCADE,
  FOREIGN KEY (converted_issue_id) REFERENCES issues(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE private_messages (
  id CHAR(36) PRIMARY KEY,
  thread_id CHAR(36) NOT NULL,
  sender_user_id CHAR(36) NULL,
  body TEXT NOT NULL,
  attachment_path VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_message_thread (thread_id, created_at),
  FOREIGN KEY (thread_id) REFERENCES private_threads(id) ON DELETE CASCADE,
  FOREIGN KEY (sender_user_id) REFERENCES users(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE service_providers (
  id CHAR(36) PRIMARY KEY,
  organization_id CHAR(36) NOT NULL,
  category ENUM('lift','zelenilo','ciscenje','elektricar','vodoinstalater','grejanje') NOT NULL,
  company VARCHAR(190) NOT NULL,
  contact_person VARCHAR(120) NULL,
  phone VARCHAR(40) NULL,
  email VARCHAR(190) NULL,
  created_at DATETIME(3) NOT NULL,
  FOREIGN KEY (organization_id) REFERENCES organizations(id) ON DELETE CASCADE
) ENGINE=InnoDB;
