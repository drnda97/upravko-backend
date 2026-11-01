-- "Platio/la sam": stanar prijavi uplatu, upravnik potvrdi da je legla.
CREATE TABLE payment_claims (
  id CHAR(36) PRIMARY KEY,
  building_id CHAR(36) NOT NULL,
  apartment_id CHAR(36) NOT NULL,
  user_id CHAR(36) NULL,
  amount DECIMAL(14,2) NOT NULL,
  status ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  decided_by CHAR(36) NULL,
  decided_at DATETIME(3) NULL,
  ledger_entry_id CHAR(36) NULL,
  created_at DATETIME(3) NOT NULL,
  KEY idx_claim_building (building_id, status),
  KEY idx_claim_apartment (apartment_id, status),
  FOREIGN KEY (building_id) REFERENCES buildings(id) ON DELETE CASCADE,
  FOREIGN KEY (apartment_id) REFERENCES apartments(id) ON DELETE CASCADE,
  FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (decided_by) REFERENCES users(id) ON DELETE SET NULL,
  FOREIGN KEY (ledger_entry_id) REFERENCES ledger_entries(id) ON DELETE SET NULL
) ENGINE=InnoDB;

CREATE TABLE payment_claim_charges (
  claim_id CHAR(36) NOT NULL,
  charge_id CHAR(36) NOT NULL,
  PRIMARY KEY (claim_id, charge_id),
  KEY idx_claim_charge (charge_id),
  FOREIGN KEY (claim_id) REFERENCES payment_claims(id) ON DELETE CASCADE,
  FOREIGN KEY (charge_id) REFERENCES charges(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- Prelazak na Infostan poništava neplaćena zaduženja; ništa se ne briše.
ALTER TABLE charges ADD COLUMN cancelled_at DATETIME(3) NULL;
