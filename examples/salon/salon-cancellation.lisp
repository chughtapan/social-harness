(norm salon-cancellation
  :description "Ask about cancelling an appointment. The salon lists appointment handles scoped to the verified customer. The customer selects one, then the salon reports the result.")

(act request :by client :starts true :sets (open waiting))
(act own-appointments :by server :when waiting :clears waiting :sets listed
  (field choices :type list :min-items 1 :max-items 3
    (item :type integer :minimum 1)))
(act cancel :by client :when listed :clears listed :sets selected
  (field appointment :type integer :minimum 1)
  (relation member appointment (previous own-appointments choices)))
(act cancelled :by server :when selected :ends true
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous cancel appointment)))
(act decline :by server :when open :ends true)
(act withdraw :by client :when waiting :ends true)
(act keep :by client :when listed :ends true)
