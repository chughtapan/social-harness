(norm alternating-offers
  :description "The client opens with a topic and candidate meeting slots for the server. The recipient of an offer accepts one offered slot, or rejects the offer and proposes alternatives in one counter-propose message. Counteroffers alternate between the two. Only the recipient of the current offer may counteroffer or accept it. Acceptance by either completes the agreement; no further confirmation or acknowledgement is needed. Either may cancel a pending negotiation or the agreed meeting without giving a reason. After cancellation, the client may open a new request-propose.")

(act request-propose :by client :starts true :sets offered
  (field topic :type string :min-length 1
    :description "The meeting subject. Its duration and a broad timeframe such as next week are allowed; candidate times belong in options.")
  (field options :type list :min-items 1 :max-items 3 :format date-time)
  (field length :type string :format duration))

(act counter-propose :by (recipient (fact offered))
  :when offered :sets offered
  (field options :type list :min-items 1 :max-items 3 :format date-time)
  (field length :type string :format duration))

(act accept-proposal :by (recipient (fact offered))
  :when offered :clears offered :sets agreed
  (field slot :type string :format date-time)
  (relation member slot (previous (fact offered) options)))

(act cancel :by (client server) :ends true)
