(norm professor-first
  :description "A student's agent, the client, requests a meeting topic from a professor's agent, the server. The server proposes candidate times; before confirmation the server may replace an offer and the client may revise which offered times are suitable. The client returns every offered option it can attend, or rejects all options. The server confirms one currently accepted time. Either may cancel the negotiation or confirmed agreement; rescheduling starts a new request after cancellation.")

(act request :by client :starts true :sets negotiating
  (field topic :type string :min-length 1
    :description "The meeting subject. Its duration, a broad timeframe such as next week and dates that belong to the subject are allowed; availability and proposed meeting times are not."))

(act propose :by server :when negotiating
  :sets offered :clears accepted
  (field options :type list :min-items 1 :max-items 3 :format date-time)
  (field length :type string :format duration))

(act accept-proposal :by client :when (negotiating offered) :sets accepted
  (field available :type list :min-items 1 :max-items 3 :format date-time)
  (relation subset available (previous (fact offered) options)))

(act reject-proposal :by client :when (negotiating offered) :clears accepted)

(act confirm :by server :when (negotiating offered accepted) :sets confirmed
  :clears (negotiating offered accepted)
  (field slot :type string :format date-time)
  (relation member slot (previous (fact accepted) available)))

(act cancel :by (client server) :ends true)
