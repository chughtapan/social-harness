(norm salon-personal-price
  :description "Quote a public price for a specified stylist and service, invite the guest to verify, and explain the earned personal price if the guest consents and the salon verifies the account.")

(act request :by client :starts true :sets public-price-requested
  (field service :type integer :minimum 1)
  (field staff :type integer :minimum 1))

(act verify-needed :by server :when public-price-requested :clears public-price-requested :sets public-price-shown
  (field service :type integer :minimum 1)
  (relation equals service (previous request service))
  (field staff :type integer :minimum 1)
  (relation equals staff (previous request staff))
  (field base-cents :type integer :minimum 0))

(act decline :by client :when public-price-shown :ends true
  (field service :type integer :minimum 1)
  (relation equals service (previous verify-needed service))
  (field staff :type integer :minimum 1)
  (relation equals staff (previous verify-needed staff)))

(act consent :by client :when public-price-shown :clears public-price-shown :sets guest-consented
  (field service :type integer :minimum 1)
  (relation equals service (previous verify-needed service))
  (field staff :type integer :minimum 1)
  (relation equals staff (previous verify-needed staff)))

(act verified-price :by server :when guest-consented :ends true
  (field service :type integer :minimum 1)
  (relation equals service (previous consent service))
  (field staff :type integer :minimum 1)
  (relation equals staff (previous consent staff))
  (field base-cents :type integer :minimum 0)
  (relation equals base-cents (previous verify-needed base-cents))
  (field discount-pct :type integer :minimum 0 :maximum 25)
  (field basis :type integer :minimum 0 :maximum 3)
  (field savings-cents :type integer :minimum 0)
  (field total-cents :type integer :minimum 0))
