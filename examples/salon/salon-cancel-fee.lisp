(norm salon-cancel-fee
  :description "A verified guest checks the cancellation fee for an existing appointment, then keeps it or confirms cancellation at the quoted amount.")

(act request :by client :starts true :sets awaiting-fee
  (field appointment :type integer :minimum 1))

(act quote :by server :when awaiting-fee :clears awaiting-fee :sets fee-shown
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous request appointment))
  (field fee-cents :type integer :minimum 0)
  (field waived :type boolean))

(act keep :by client :when fee-shown :ends true
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous quote appointment)))

(act confirm :by client :when fee-shown :clears fee-shown :sets fee-accepted
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous quote appointment))
  (field fee-cents :type integer :minimum 0)
  (relation equals fee-cents (previous quote fee-cents)))

(act cancelled :by server :when fee-accepted :ends true
  (field appointment :type integer :minimum 1)
  (relation equals appointment (previous confirm appointment))
  (field fee-cents :type integer :minimum 0)
  (relation equals fee-cents (previous confirm fee-cents)))
