; Look up both IDs in the service catalog in README.md. For deep conditioning
; with a blowout, send (ask-prices :norm salon-addon-prices :addon 22 :companion 5).
; Both amounts in the reply price just the deep conditioning, in cents.
(norm salon-addon-prices
  :description "Ask for the pre-discount price of a selected add-on alone and with a named companion service.")

(act ask-prices :by client :starts true :sets asked-for-prices
  (field addon :type integer :minimum 1)
  (field companion :type integer :minimum 1))

(act line-prices :by server :when asked-for-prices :ends true
  (field addon :type integer :minimum 1)
  (field companion :type integer :minimum 1)
  (relation equals addon (previous ask-prices addon))
  (relation equals companion (previous ask-prices companion))
  (field standalone-cents :type integer :minimum 0)
  (field with-companion-cents :type integer :minimum 0))
